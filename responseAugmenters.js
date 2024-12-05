import _ from "lodash";
import GoogleSheetsProvider from "./providers/googleSheets.js";
import { findBankMapping, findCompanyMapping } from "./utils/transliterate.js";
import crypto from "crypto";
import Keyv from "keyv";
import KeyvFile from "keyv-file";
import ms from "ms";

const keyv = new Keyv({
    store: new KeyvFile.KeyvFile({ filename: "storage/cache.json" }),
});

// Helper function to get TTL with jitter to avoid cache stampede
const getJitteredTTL = (baseInterval, jitterMinutes = 0) => {
    return ms(baseInterval) + Math.round(Math.random() * jitterMinutes * 60000);
};

// Helper function to create cache key
const createCacheKey = (prefix, params = {}) => {
    return crypto
        .createHash("sha1")
        .update(prefix + JSON.stringify(params))
        .digest("hex");
};

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

        const cacheKey = createCacheKey("banks");
        const cached = await keyv.get(cacheKey);
        if (cached) {
            return cached;
        }

        const doc = await GoogleSheetsProvider.getInstance().getDocument();

        // Keep the original bank list
        const originalBanks = (data || []).map((bank) => {
            bank.extra = false;
            return bank;
        });

        // Get sheet names
        const sheetNames = doc.sheetsByIndex.map((s) => s.title);

        const mappedBanks = sheetNames
            .filter((name) => !name.startsWith("-"))
            .map((name) => ({
                id: findBankMapping(name),
                name,
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

        const result = [...newBanks, ...originalBanks];

        // Cache the result
        const ttl = getJitteredTTL(
            process.env.GOOGLE_SHEETS_CACHE_INTERVAL || "1h"
        );
        await keyv.set(cacheKey, result, ttl);

        return result;
    }
}

// Company list augmenter
class CompanyListAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.endsWith("/companyList");
    }

    async augment(req, data) {
        console.log("Augmenting company list");

        const cacheKey = createCacheKey("companies");
        const cached = await keyv.get(cacheKey);
        if (cached) {
            return cached;
        }

        const originalCompanies = (data || []).map((company) => {
            company.extra = false;
            return company;
        });

        const doc = await GoogleSheetsProvider.getInstance().getDocument();

        const companyNamesPromises = doc.sheetsByIndex.map(async (s) => {
            await s.loadHeaderRow();
            return s.headerValues
                .slice(1)
                .filter((name) => !name.startsWith("-"));
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

        const result = [...newCompanies, ...originalCompanies];

        // Cache the result
        const ttl = getJitteredTTL(
            process.env.GOOGLE_SHEETS_CACHE_INTERVAL || "1h"
        );
        await keyv.set(cacheKey, result, ttl);

        return result;
    }
}

// PreCalcPolicyPrice augmenter
class PreCalcPolicyPriceAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.includes("/preCalcPolicyPrice/");
    }

    async augment(req, data) {
        console.log("Augmenting preCalcPolicyPrice response");

        return { ...data, tildaExtra: await this.fetchExtra(req) };
    }

    async fetchColumn(params) {
        const cacheKey = createCacheKey("column", {
            bankId: params.bankId,
            companyId: params.companyId,
        });

        let results = await keyv.get(cacheKey);
        if (results) {
            return results;
        }

        results = [];

        const doc = await GoogleSheetsProvider.getInstance().getDocument();
        const sheets = doc.sheetsByIndex;

        for (const sheet of sheets) {
            // Spread google API requests to avoid throttling
            await new Promise((resolve) =>
                setTimeout(resolve, 500 + Math.random() * 2500)
            );

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

                    acc[type].push({ type, ...data });
                };

                const createEntry = (value, extraFields = {}) => ({
                    value: parseFloat(value.replace(",", ".")),
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

                const getKvType = (type) => {
                    if (type.startsWith("кв")) {
                        if (type.includes("имущество")) {
                            return "property";
                        } else if (type.includes("титул")) {
                            return "title";
                        } else if (type.includes("жизнь")) {
                            return "life";
                        }
                    }
                };

                const handleProperty = (acc, type, value) => {
                    const propertyType = getPropertyType(type);
                    const extraFields = { propertyType };

                    if (propertyType === "house") {
                        extraFields.propertyWoodenFloor =
                            type === "дом (дерево)";
                    }

                    if (value) {
                        addEntry(
                            acc,
                            "property",
                            createEntry(value, extraFields)
                        );
                    }
                };

                const handleTitle = (acc, value) => {
                    if (value) {
                        addEntry(acc, "title", createEntry(value));
                    }
                };

                const handleLife = (acc, value, gender, age) => {
                    if (value) {
                        addEntry(
                            acc,
                            "life",
                            createEntry(value, { gender, age })
                        );
                    }
                };

                const handleKv = (acc, type, value) => {
                    if (value) {
                        addEntry(
                            acc,
                            "kv",
                            createEntry(value, { kvType: getKvType(type) })
                        );
                    }
                };

                // Process rows
                let currentLifeGender = null;
                const rowsByType = rows.reduce((acc, row) => {
                    const type = (row._rawData[0] || "").toLowerCase().trim();
                    if (!type) return acc;

                    const value = row._rawData[columnIndex];

                    switch (true) {
                        case type === "титул":
                            handleTitle(acc, value);
                            break;

                        case type.startsWith("жизнь"):
                            currentLifeGender = type.includes("м")
                                ? "male"
                                : "female";
                            if (!acc["life"]) acc["life"] = [];
                            break;

                        case type.startsWith("кв "):
                            handleKv(acc, type, value);
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
                            handleProperty(acc, type, value);
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
        const ttl = getJitteredTTL(
            process.env.GOOGLE_SHEETS_CACHE_INTERVAL || "1h"
        );
        await keyv.set(cacheKey, results, ttl);

        return results;
    }

    async resolvePrice(params) {
        try {
            const column = await this.fetchColumn(params);

            const aggregate = column.filter((r) => {
                switch (true) {
                    case params.insuranceProperty && r.type === "property":
                        let predicate = r.propertyType === params.propertyType;

                        if (params.propertyType == "house") {
                            predicate =
                                predicate &&
                                r.propertyWoodenFloor ===
                                    params.propertyWoodenFloor;
                        }

                        return predicate;
                    case params.insuranceLife && r.type === "life":
                        return r.gender === params.sex && r.age === params.age;
                    case params.insuranceTitle && r.type === "title":
                        return true;
                    default:
                        return false;
                }
            });

            const kvTypes = {
                insuranceProperty: "property",
                insuranceTitle: "title",
                insuranceLife: "life",
            };

            const kv = Object.entries(kvTypes).reduce(
                (acc, [param, kvType]) => {
                    if (params[param]) {
                        return (
                            acc +
                            (column.find(
                                (r) => r.type === "kv" && r.kvType === kvType
                            )?.value || 0)
                        );
                    }
                    return acc;
                },
                0
            );

            const total =
                params.creditSum *
                aggregate.reduce((acc, r) => acc + r.value, 0);

            let partnerKv = kv * total;

            if (total >= 3000) {
                partnerKv += 1000;
            }

            return {
                total,
                partnerKv,
            };
        } catch (error) {
            // console.error("Error getting sheet results:", error);
            return 0;
        }
    }

    async fetchExtra(req) {
        const bankId = req.body.bankCode || "";
        const companyId = req.url.split("/").pop();

        const params = {
            bankId,
            companyId,
            creditSum: req.body.form?.creditSum || 0,
            insuranceLife: req.body.insuranceLife == true,
            insuranceProperty: req.body.insuranceProperty == true,
            insuranceTitle: req.body.insuranceTitle == true,
            sex: (req.body.form?.sex || "").toLowerCase(),
            age: req.body.form?.age,
            propertyType: (req.body.form?.propertyType || "").toLowerCase(),
            propertyWoodenFloor: req.body.form?.propertyWoodenFloor == true,
        };

        const { total, partnerKv } = await this.resolvePrice(params);

        if (total == 0) {
            return {};
        }

        return {
            companyId,
            total,
            partnerKv,
        };
    }

    async handleError(req, error) {
        // console.log(error.response.status)
        if (error.response?.status === 400) {
            // console.log("Handling 400 error for preCalcPolicyPrice");

            // Make deep copy without mutating original message array
            const message = JSON.parse(
                JSON.stringify(error.response.data?.errorMessages || [])
            ).pop();

            if (
                (message || "").includes(
                    "не поддерживает комплексное страхование жизни и имущества для указанного банка"
                )
            ) {
                throw error;
            }

            return {
                tildaExtra: await this.fetchExtra(req),
            };
        }

        throw error;
    }
}

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
