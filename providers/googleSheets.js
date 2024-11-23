import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

class GoogleSheetsProvider {
    constructor() {
        this.jwt = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: process.env.GOOGLE_PRIVATE_KEY,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
    }

    async getDocument() {
        const doc = new GoogleSpreadsheet(
            process.env.GOOGLE_SPREADSHEET_ID || "",
            this.jwt
        );

        await doc.loadInfo();
        return doc;
    }

    static getInstance() {
        if (!GoogleSheetsProvider.instance) {
            GoogleSheetsProvider.instance = new GoogleSheetsProvider();
        }
        return GoogleSheetsProvider.instance;
    }
}

export default GoogleSheetsProvider;
