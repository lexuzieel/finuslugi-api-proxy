import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";
import Graceful from "@ladjs/graceful";
import responseAugmenter from "./responseAugmenters.js";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// URL of the API you want to proxy
const apiEndpoint = "https://finuslugi.ru";

// Use CORS middleware
app.use((req, res, next) => {
    const origin = req.get("origin");

    const allowedOrigins = process.env.API_CORS_DOMAINS?.split(",") || [];

    if (allowedOrigins.length == 0) {
        // Skip CORS when no origins are allowed
        return cors({
            origin: "*",
        })(req, res, next);
    }

    if (!allowedOrigins.includes(origin)) {
        console.warn(`Request from origin ${origin} not allowed`);
        res.sendStatus(403);
        return;
    }

    return cors({
        origin,
    })(req, res, next);
});

app.use(express.json());

const authorizeRequest = (req, res, next) => {
    const apiKey = process.env.API_KEY || "";
    const key = req.headers["x-api-key"] || "";

    if (apiKey.length > 0 && apiKey != key) {
        res.sendStatus(401);
    } else {
        next();
    }
};

app.use(authorizeRequest);

const normalizeUrl = (url) => {
    if (url.startsWith(process.env.API_PATH_PREFIX)) {
        return url.replace(process.env.API_PATH_PREFIX, "");
    }

    return url;
};

app.post("*/api/*/partnerLogin", async (req, res) => {
    const url = normalizeUrl(req.url);

    console.log(req.method, url);

    const headers = {
        accept: req.headers["accept"],
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
                tokenIsPrivate:
                    process.env.FINUSLUGI_API_PRIVATE_TOKEN == "true" || false,
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
    const url = normalizeUrl(req.url);

    console.log(req.method, url);

    if (req.method != "GET" && req.method != "POST") {
        res.status(405).send({ error: "Method not allowed" });
    }

    const headers = {
        accept: req.headers["accept"],
        "content-type": req.headers["content-type"],
        authorization: req.headers.authorization,
    };

    try {
        const axiosPromise = axios({
            method: req.method,
            url: apiEndpoint + url,
            headers,
            data: req.method == "POST" ? req.body : undefined,
        });

        const augmentedResponse = await responseAugmenter.augmentResponse(
            req,
            axiosPromise
        );

        res.send(augmentedResponse);
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

