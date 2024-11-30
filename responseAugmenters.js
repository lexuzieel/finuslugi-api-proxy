import _ from "lodash";
import GoogleSheetsProvider from "./providers/googleSheets.js";
import { findBankMapping, findCompanyMapping } from "./utils/transliterate.js";
import axios from "axios";

// Base class for response augmentation
class ResponseAugmenter {
    canHandle(url) {
        throw new Error("Not implemented");
    }

    async augment(data) {
        throw new Error("Not implemented");
    }

    // New method to handle errors
    async handleError(error) {
        // By default, propagate the error
        throw error;
    }
}

// Bank list augmenter
class BankListAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.endsWith("/bankList");
    }

    async augment(req, data) {
        console.debug("Augmenting bank list");

        const doc = await GoogleSheetsProvider.getInstance().getDocument();

        // Keep the original bank list
        const originalBanks = (data || []).map((bank) => {
            bank.extra = false;
            return bank;
        });

        // Get sheet names
        const sheetNames = doc.sheetsByIndex.map((s) => s.title);

        const mappedBanks = sheetNames.map((sheetName) => ({
            id: findBankMapping(sheetName),
            name: sheetName,
            extra: true,
        }));

        console.debug("Mapped banks:", mappedBanks);

        // Keep only new bank ids
        const newBanks = mappedBanks.filter(
            (mappedBank) =>
                !originalBanks.some(
                    (originalBank) => originalBank.id === mappedBank.id
                )
        );

        return [...newBanks, ...originalBanks];
    }
}

// Company list augmenter
class CompanyListAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.endsWith("/companyList");
    }

    async augment(req, data) {
        console.log("Augmenting company list");

        const originalCompanies = (data || []).map((company) => {
            company.extra = false;
            return company;
        });

        const doc = await GoogleSheetsProvider.getInstance().getDocument();

        const companyNamesPromises = doc.sheetsByIndex.map(async (s) => {
            await s.loadHeaderRow();
            return s.headerValues.slice(1);
        });

        const companyNames = await Promise.all(companyNamesPromises).then(
            (res) => [...new Set(res.flat())]
        );

        console.debug("Company names:", companyNames);

        const mappedCompanyNames = companyNames.map((companyName) => ({
            id: findCompanyMapping(companyName),
            name: companyName,
            extra: true,
        }));

        console.debug("Mapped companies:", mappedCompanyNames);

        // Keep only new company ids
        const newCompanies = mappedCompanyNames.filter(
            (mappedCompany) =>
                !originalCompanies.some(
                    (originalCompany) => originalCompany.id === mappedCompany.id
                )
        );

        return [...newCompanies, ...originalCompanies];
    }
}

// PreCalcPolicyPrice augmenter
class PreCalcPolicyPriceAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.includes("/preCalcPolicyPrice/");
    }

    async augment(req, data) {
        console.log("Augmenting preCalcPolicyPrice response");

        return { ...data, tildaExtra: [{ ...data, isExtra: true }] };

        // Process API response data if exists
        const apiResults =
            data && data.length
                ? data.map((item) => ({
                      ...item,
                      bankId: findBankMapping(item.bankName),
                      companyId: findCompanyMapping(item.insuranceCompanyName),
                      isActual: true,
                      source: "api",
                  }))
                : [];

        // Get data from Google Sheets
        const sheetResults = await this.getSheetResults();

        // Merge results
        const allResults = [...apiResults, ...sheetResults];

        console.debug("Augmented preCalcPolicyPrice data:", allResults);
        return allResults;
    }

    async getSheetResults(params) {
        try {
            const doc = await GoogleSheetsProvider.getInstance().getDocument();
            const sheets = doc.sheetsByIndex;
            const results = [];

            // return results;

            for (const sheet of sheets) {
                const bankName = sheet.title;
                const bankId = findBankMapping(bankName);

                if (params.bankId && bankId !== params.bankId) {
                    continue;
                }

                // Load header row to get company names
                await sheet.loadHeaderRow();
                const companyNames = sheet.headerValues.slice(1); // Skip first column

                for (const companyName of companyNames) {
                    const companyId = findCompanyMapping(companyName);

                    if (params.companyId && companyId !== params.companyId) {
                        continue;
                    }

                    // get column for company name from bank sheet
                    const columnIndex = sheet.headerValues.findIndex(
                        (header) => header === companyName
                    );
                    if (columnIndex === -1) continue;

                    // Get all rows for this company's column
                    const rows = await sheet.getRows();

                    const addEntry = (acc, type, data) => {
                        if (!acc[type]) {
                            acc[type] = [];
                        }

                        acc[type].push(data);
                    };

                    const createEntry = (type, value, extraFields = {}) => ({
                        type,
                        price: parseFloat(value),
                        ...extraFields,
                    });

                    const getPropertyType = (type) => {
                        switch (type) {
                            case "дом (дерево)":
                            case "дом (кирпич)":
                                return "house";
                            case "комната":
                                return "room";
                            case "апартаменты":
                                return "apartments";
                            case "машино-место":
                                return "parkingSpace";
                            default:
                                return "flat";
                        }
                    };

                    const handleProperty = (acc, type, value, params) => {
                        const propertyType = getPropertyType(type);
                        const extraFields = {};

                        if (propertyType === "house") {
                            extraFields.propertyWoodenFloor =
                                type === "дом (дерево)";
                        }

                        if (
                            !params.propertyType ||
                            params.propertyType === propertyType
                        ) {
                            if (value) {
                                addEntry(
                                    acc,
                                    propertyType,
                                    createEntry(
                                        propertyType,
                                        value,
                                        extraFields
                                    )
                                );
                            }
                        }
                    };

                    const handleTitle = (acc, value) => {
                        if (value) {
                            addEntry(acc, "title", createEntry("title", value));
                        }
                    };

                    const handleLife = (acc, value, gender, age) => {
                        if (value) {
                            addEntry(
                                acc,
                                "life",
                                createEntry("life", value, { gender, age })
                            );
                        }
                    };

                    // Process rows
                    let currentLifeGender = null;
                    const rowsByType = rows.reduce((acc, row) => {
                        const type = row._rawData[0].toLowerCase().trim();
                        if (!type) return acc;

                        const value = row._rawData[columnIndex];

                        switch (true) {
                            case type === "титул":
                                handleTitle(acc, value);
                                break;

                            case type.startsWith("жизнь"):
                                currentLifeGender = type.includes("М")
                                    ? "male"
                                    : "female";
                                if (!acc["life"]) acc["life"] = [];
                                break;

                            case currentLifeGender && !isNaN(parseInt(type)):
                                handleLife(
                                    acc,
                                    value,
                                    currentLifeGender,
                                    parseInt(type)
                                );
                                break;

                            default:
                                currentLifeGender = null;
                                handleProperty(acc, type, value, params);
                        }

                        return acc;
                    }, {});

                    // Flatten and add results
                    results.push(
                        ...Object.values(rowsByType)
                            .flat()
                            .map((entry) => ({
                                bankId,
                                companyId,
                                ...entry,
                            }))
                    );
                }
            }

            return results;
        } catch (error) {
            console.error("Error getting sheet results:", error);
            return [];
        }
    }

    async fetchExtra(req) {
        const bankId = req.body.bankCode || "";
        const companyId = req.url.split("/").pop();

        const sheetResults = await this.getSheetResults({
            bankId,
            companyId,
            ...req.body,
        });

        console.log(
            sheetResults
            // sheetResults.filter(
            //     (r) =>
            //         r.bankId.toLowerCase() === bankId.toLowerCase() &&
            //         r.companyId.toLowerCase() === companyId.toLowerCase()
            // )
        );

        return [
            {
                companyId,
                total: 0.1,
                // lifeInsuranceCreditSum: 541256,
                // calcId: "b3f910ce-15f1-4eed-918c-da3800f7b62f",
                // partnerKv: 235.17,
                // partnerId: 65738,
            },
        ];
    }

    async handleError(req, error) {
        if (error.response?.status === 400) {
            console.log("Handling 400 error for preCalcPolicyPrice");

            return {
                tildaExtra: await this.fetchExtra(req),
            };
        }

        throw error;
    }
}

// Response augmentation manager
class ResponseAugmentationManager {
    constructor() {
        this.augmenters = [
            new BankListAugmenter(),
            new CompanyListAugmenter(),
            new PreCalcPolicyPriceAugmenter(),
        ];
    }

    async augmentResponse(req, axiosPromise) {
        for (const augmenter of this.augmenters) {
            if (augmenter.canHandle(req.url)) {
                try {
                    const response = await axiosPromise;
                    return await augmenter.augment(req, response.data);
                } catch (error) {
                    if (augmenter.handleError) {
                        return await augmenter.handleError(req, error);
                    } else {
                        throw error;
                    }
                }
            }
        }

        return response.data;
    }
}

export default new ResponseAugmentationManager();

