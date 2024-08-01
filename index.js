import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config();

const app = express();
const port = 3000;

// URL of the API you want to proxy
const apiEndpoint = "https://finuslugi.ru";

// Use CORS middleware
app.use(
    cors({
        origin: 'http://project9253441.tilda.ws',
    }),
);

app.use(express.json());

app.post("*/api/*/partnerLogin", async (req, res) => {
    console.log(req.method, req.url)

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
            url: apiEndpoint + req.url,
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
    console.log(req.method, req.url)

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
            url: apiEndpoint + req.url,
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

app.listen(port, () => {
    console.log(`Proxy server listening at http://localhost:${port}`);
});
