import _ from "lodash";
import GoogleSheetsProvider from "./providers/googleSheets.js";
import { findBankMapping, findCompanyMapping } from "./utils/transliterate.js";

// Base class for response augmentation
class ResponseAugmenter {
    canHandle(url) {
        throw new Error("Not implemented");
    }

    async augment(data) {
        throw new Error("Not implemented");
    }
}

// Bank list augmenter
class BankListAugmenter extends ResponseAugmenter {
    canHandle(url) {
        return url.endsWith("/bankList");
    }

    async augment(data) {
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

    async augment(data) {
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

// Response augmentation manager
class ResponseAugmentationManager {
    constructor() {
        this.augmenters = [new BankListAugmenter(), new CompanyListAugmenter()];
    }

    augmentResponse(req, data) {
        for (const augmenter of this.augmenters) {
            if (augmenter.canHandle(req.url)) {
                return augmenter.augment(data);
            }
        }

        return data;
    }
}

export default new ResponseAugmentationManager();

