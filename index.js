import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import Graceful from "@ladjs/graceful";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// URL of the API you want to proxy
const apiEndpoint = "https://finuslugi.ru";

// Use CORS middleware
app.use(
    cors({
        origin: 'http://project9253441.tilda.ws',
    }),
);

app.use(express.json());

const normalizeUrl = (url) => {
    if (url.startsWith(process.env.API_PATH_PREFIX)) {
        return url.replace(process.env.API_PATH_PREFIX, "")
    }

    return url
}

app.post("*/api/*/partnerLogin", async (req, res) => {
    const url = normalizeUrl(req.url)

    console.log(req.method, url)

    const headers = {
        "accept": req.headers["accept"],
        "content-type": req.headers["content-type"],
    };

    try {
        const passwordMd5 = crypto
            .createHash("md5")
            .update(process.env.FINUSLUGI_API_PASSWORD || "")
            .digest("hex");

        const response = await axios({
            method: req.method,
            url: apiEndpoint + url,
            headers,
            data: {
                ...req.body,
                email: process.env.FINUSLUGI_API_EMAIL || "",
                passwordMd5,
                tokenIsPrivate: process.env.FINUSLUGI_API_PRIVATE_TOKEN == 'true' || false,
            },
        });

        res.send(response.data);
    } catch (e) {
        if (e.response) {
            const response = e.response;
            res.status(response.status).send(response.data);
        } else {
            console.error(e);
            res.status(500).send({ error: "Unexpected server error" });
        }
    }
});

app.all("*/api/*", async (req, res) => {
    const url = normalizeUrl(req.url)

    console.log(req.method, url)

    if (req.method != "GET" && req.method != "POST") {
        res.status(405).send({ error: "Method not allowed" })
    }

    const headers = {
        "accept": req.headers["accept"],
        "content-type": req.headers["content-type"],
        authorization: req.headers.authorization,
    };

    try {
        const response = await axios({
            method: req.method,
            url: apiEndpoint + url,
            headers,
            data: req.method == "POST" ? req.body : undefined,
        });

        res.send(response.data);
    } catch (e) {
        if (e.response) {
            const response = e.response;
            res.status(response.status).send(response.data);
        } else {
            console.error(e);
            res.status(500).send({ error: "Unexpected server error" });
        }
    }
});

const server = app.listen(port, () => {
    console.log(`Proxy server listening at http://localhost:${port}`);
});

const graceful = new Graceful({ servers: [server] });

graceful.listen();
