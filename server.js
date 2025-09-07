 // server.js
const express = require("express");
const cors = require("cors");
// const fetch = require("node-fetch"); // si usas Node < 18, descomentar e instalar
const { setTimeout: delay } = require("timers/promises");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ CORS: en producción, restringí a tu dominio
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? ["https://presupuestador-boxes.vercel.app/"] // <-- cámbialo por tu dominio real
    : true
}));

app.get("/", (_req, res) => {
  res.type("text/plain").send("Proxy OK (MANN + WIX)");
});

/* =============== Utils =============== */
const ALLOWED_FILTERS = new Set([
  "ALL_FILTER",
  "OIL_FILTER",
  "AIR_FILTER",
  "FUEL_FILTER",
  "CABIN_AIR_FILTER",
  "SPECIAL_APPLICATIONS_FILTER",
]);

function normFilter(f) {
  const v = String(f || "ALL_FILTER").toUpperCase();
  return ALLOWED_FILTERS.has(v) ? v : "ALL_FILTER";
}

// Pequeño helper de fetch con timeout
async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally {
    clearTimeout(id);
  }
}

/* =============== MANN =============== */
const MANN_ENDPOINT = "https://www.mann-filter.com/api/graphql/catalog-prod";
const MANN_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family __typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

app.get("/api/mann", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const pageSize = 30; // 🔒 fijo en 30
    const filterBy = normFilter(req.query.filterBy);

    const variables = {
      search: qRaw.replace(/\s+/g, "+").toLowerCase(),
      currentPage: page,
      pageSize,
      filterBy,
    };

    const params = new URLSearchParams({
      query: MANN_QUERY,
      variables: JSON.stringify(variables),
    });

    const r = await fetchWithTimeout(`${MANN_ENDPOINT}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.mann-filter.com/",
      },
    }, 12000);

    const ct = r.headers.get("content-type") || "application/json";
    const body = await r.text();
    res.setHeader("X-Proxy-Upstream", "mann-filter.com"); // 👀 trazabilidad
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(r.status).send(body);
  } catch (e) {
    console.error("[MANN] ", e);
    res.setHeader("X-Proxy-Upstream", "mann-filter.com");
    res.status(500).json({ error: e?.message || "Proxy error (MANN)" });
  }
});

/* =============== WIX =============== */
const WIX_ENDPOINT = "https://www.wixfilters.com/api/graphql/catalog-prod";
const WIX_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}references{referenceTypeId:reference_type_id referenceTypeName:reference_type_name referenceTypeDescription:reference_type_description referenceProducts:reference_products{salesDesignation:sales_designation urlKey:url_key __typename}__typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family textLinkages:linkages{module_name module_unit module_value __typename}__typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

app.get("/api/wix", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const pageSize = 30; // 🔒 fijo en 30
    const filterBy = normFilter(req.query.filterBy);

    const variables = {
      search: qRaw.replace(/\s+/g, "+").toLowerCase(),
      currentPage: page,
      pageSize,
      filterBy,
    };

    const params = new URLSearchParams({
      query: WIX_QUERY,
      variables: JSON.stringify(variables),
    });

    const r = await fetchWithTimeout(`${WIX_ENDPOINT}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.wixfilters.com/",
      },
    }, 12000);

    const ct = r.headers.get("content-type") || "application/json";
    const body = await r.text();
    res.setHeader("X-Proxy-Upstream", "wixfilters.com"); // 👀 trazabilidad
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(r.status).send(body);
  } catch (e) {
    console.error("[WIX] ", e);
    res.setHeader("X-Proxy-Upstream", "wixfilters.com");
    res.status(500).json({ error: e?.message || "Proxy error (WIX)" });
  }
});

/* ====== start ====== */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
