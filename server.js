 // server.js
const express = require("express");
const cors = require("cors");
// Si tu Node es < 18, descomentá y npm i node-fetch
// const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true }));

// Healthcheck
app.get("/", (_req, res) => {
  res.type("text/plain").send("Proxy OK (MANN + WIX)");
});

/* =========================
 *  MANN (ya lo tenías)
 * ========================= */
const MANN_ENDPOINT = "https://www.mann-filter.com/api/graphql/catalog-prod";
const MANN_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family __typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

// Ej: /api/mann?q=PH5548&page=1&size=30&filterBy=ALL_FILTER
app.get("/api/mann", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const size = Number.parseInt(req.query.size || "30", 10) || 30; // ← 30 por default
    const filterBy = String(req.query.filterBy || "ALL_FILTER");

    const variables = {
      search: qRaw.replace(/\s+/g, "+").toLowerCase(),
      currentPage: page,
      pageSize: size,
      filterBy,
    };

    const params = new URLSearchParams({
      query: MANN_QUERY,
      variables: JSON.stringify(variables),
    });

    const r = await fetch(`${MANN_ENDPOINT}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.mann-filter.com/",
      },
    });

    const ct = r.headers.get("content-type") || "application/json";
    const body = await r.text();
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(r.status).send(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Proxy error (MANN)" });
  }
});

/* =========================
 *  WIX Filters
 * ========================= */
const WIX_ENDPOINT = "https://www.wixfilters.com/api/graphql/catalog-prod";

/**
 * Query GraphQL basada en la que pasaste (incluye: items.product.attributes,
 * references y textLinkages; y pageInfo/totalCount para paginación).
 */
const WIX_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}references{referenceTypeId:reference_type_id referenceTypeName:reference_type_name referenceTypeDescription:reference_type_description referenceProducts:reference_products{salesDesignation:sales_designation urlKey:url_key __typename}__typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family textLinkages:linkages{module_name module_unit module_value __typename}__typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

/**
 * Endpoint: /api/wix
 * Params:
 *  - q        (string, requerido) término de búsqueda, ej: W712, PH5548, etc.
 *  - page     (int, opcional)     página (default 1)
 *  - size     (int, opcional)     tamaño de página (default 30)
 *  - filterBy (string, opcional)  ALL_FILTER | OIL_FILTER | AIR_FILTER | FUEL_FILTER | CABIN_AIR_FILTER | SPECIAL_APPLICATIONS_FILTER
 */
app.get("/api/wix", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const size = Number.parseInt(req.query.size || "30", 10) || 30; // ← 30 por default
    const filterBy = String(req.query.filterBy || "ALL_FILTER");

    // En el sitio oficial vimos normalización (espacios->+, lower)
    const search = qRaw.replace(/\s+/g, "+").toLowerCase();

    const variables = { search, currentPage: page, pageSize: size, filterBy };

    const params = new URLSearchParams({
      query: WIX_QUERY,
      variables: JSON.stringify(variables),
    });

    const target = `${WIX_ENDPOINT}?${params.toString()}`;

    const r = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.wixfilters.com/",
      },
    });

    const ct = r.headers.get("content-type") || "application/json";
    const body = await r.text();
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(r.status).send(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Proxy error (WIX)" });
  }
});

/* ====== start ====== */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
