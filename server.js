 // server.js
const express = require("express");
const cors = require("cors");
// Para Node < 18, descomenta y agrega la dependencia:
// const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
 *  CORS
 * ========================= */
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? [
            // ⚠️ Cambia esto por el dominio real de tu front
            "https://presupuestador-boxes.vercel.app",
          ]
        : true,
  })
);

/* =========================
 *  Healthcheck
 * ========================= */
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("Proxy OK (MANN + WIX) — /api/mann y /api/wix listos");
});

/* =========================
 *  Utils
 * ========================= */
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

async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/* =========================
 *  MANN
 * ========================= */
const MANN_ENDPOINT = "https://www.mann-filter.com/api/graphql/catalog-prod";
const MANN_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family __typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

app.get("/api/mann", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const pageSize = 100; // tamaño fijo
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

    const url = `${MANN_ENDPOINT}?${params.toString()}`;
    console.log("[MANN] →", url);

    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.mann-filter.com/",
        },
      },
      12000
    );

    const body = await r.text();
    res.setHeader("X-Proxy-Upstream", "mann-filter.com");
    res.setHeader("X-From-Proxy-Route", "/api/mann");
    res.setHeader("Cache-Control", "public, max-age=100");
    res
      .status(r.status)
      .type(r.headers.get("content-type") || "application/json")
      .send(body);
  } catch (e) {
    console.error("[MANN] ERROR:", e);
    res.setHeader("X-Proxy-Upstream", "mann-filter.com");
    res.status(500).json({ error: e?.message || "Proxy error (MANN)" });
  }
});

/* =========================
 *  WIX
 * ========================= */
const WIX_ENDPOINT = "https://www.wixfilters.com/api/graphql/catalog-prod";
const WIX_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}references{referenceTypeId:reference_type_id referenceTypeName:reference_type_name referenceTypeDescription:reference_type_description referenceProducts:reference_products{salesDesignation:sales_designation urlKey:url_key __typename}__typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family textLinkages:linkages{module_name module_unit module_value __typename}__typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

app.get("/api/wix", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const pageSize = 30; // tamaño fijo
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

    const url = `${WIX_ENDPOINT}?${params.toString()}`;
    console.log("[WIX]  →", url);

    const r = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.wixfilters.com/",
        },
      },
      12000
    );

    const body = await r.text();
    res.setHeader("X-Proxy-Upstream", "wixfilters.com");
    res.setHeader("X-From-Proxy-Route", "/api/wix");
    res.setHeader("Cache-Control", "public, max-age=30");
    res
      .status(r.status)
      .type(r.headers.get("content-type") || "application/json")
      .send(body);
  } catch (e) {
    console.error("[WIX]  ERROR:", e);
    res.setHeader("X-Proxy-Upstream", "wixfilters.com");
    res.status(500).json({ error: e?.message || "Proxy error (WIX)" });
  }
});

/* =========================
 *  Start
 * ========================= */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
