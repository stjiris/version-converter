import { Client } from "@elastic/elasticsearch";

export const client = new Client({node: process.env.ES_URL || "http://localhost:9200", auth: {username: process.env.ES_USER || "", password: process.env.ES_PASS || ""}})