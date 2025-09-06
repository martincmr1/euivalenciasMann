 // server.js
const express = require("express");
const cors = require("cors");
// Si tu Node es < 18, descomenta la siguiente línea y agregá la dependencia:
// const fetch = require("node-fetch");

const app = express();

// Config
const PORT = process.env.PORT || 3000; // dejalo en 3000 si así lo tenés funcionando

// CORS (en prod conviene restringir al dominio de tu front)
app.use(cors({ origin: true }));

// Healthcheck
app.get("/", (_req, res) => {
  res.type("text/plain").send("MANN proxy OK");
});

// ====== Constantes de MANN ======
const GRAPHQL_ENDPOINT = "https://www.mann-filter.com/api/graphql/catalog-prod";
const GRAPHQL_QUERY =
  "query($search:String!$currentPage:Int!$pageSize:Int!$filterBy:TYPE_OF_FILTER){catalogSearch:search_crossreference_no(search:$search currentPage:$currentPage pageSize:$pageSize filterBy:$filterBy){availableFilters:available_filters{label totalProducts:total_products code __typename}items{product{name sku urlKey:url_key attributes:attributes_value{key value adminValue:admin_value __typename}__typename}externalNumber:external_number intProductIdentifier:int_product_identifier externalProductName:ext_product_name manufacturer:ext_brand_name filterBy:aa_product_family __typename}pageInfo:page_info{currentPage:current_page pageSize:page_size totalPages:total_pages __typename}totalCount:total_count __typename}}";

// ====== /api/mann ======
// Parámetros:
//   q        (string)  término de búsqueda (requerido), ej: PH5548
//   page     (int)     página (default 1)
//   size     (int)     tamaño de página (default 15)
//   filterBy (string)  ALL_FILTER | OIL_FILTER | AIR_FILTER | FUEL_FILTER | CABIN_AIR_FILTER | SPECIAL_APPLICATIONS_FILTER
app.get("/api/mann", async (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    if (!qRaw) return res.status(400).json({ error: "Falta parámetro q" });

    const page = Number.parseInt(req.query.page || "1", 10) || 1;
    const size = Number.parseInt(req.query.size || "15", 10) || 15;
    const filterBy = String(req.query.filterBy || "ALL_FILTER");

    // Normalizar como vimos que hace el sitio: espacios -> + y lower
    const search = qRaw.replace(/\s+/g, "+").toLowerCase();

    const variables = {
      search,
      currentPage: page,
      pageSize: size,
      filterBy,
    };

    const params = new URLSearchParams({
      query: GRAPHQL_QUERY,
      variables: JSON.stringify(variables),
    });

    const target = `${GRAPHQL_ENDPOINT}?${params.toString()}`;

    const r = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.mann-filter.com/",
      },
    });

    const contentType = r.headers.get("content-type") || "application/json";
    const body = await r.text();

    res.setHeader("Content-Type", contentType);
    // cache suave opcional
    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(r.status).send(body);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e?.message || "Proxy error" });
  }
});

// Levantar
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
