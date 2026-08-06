/**
 * servidorFiltros.js
 *
 * Función serverless para Vercel que consulta el catálogo de MANN-FILTER.
 *
 * UBICACIÓN:
 *   /api/servicorFiltros.js
 *
 * ENDPOINT PUBLICADO:
 *   https://TU-PROYECTO.vercel.app/api/servicorFiltros
 *
 * ACCIONES:
 *   GET  ?action=health
 *   GET  ?action=brands&q=ford
 *   GET  ?action=models&brandId=00000000000019&categoryId=
 *   GET  ?action=versions&modelId=00000000007390
 *   GET  ?action=filters&vehicleTypeId=00000000191521&filterBy=ALL_FILTER
 *   GET  ?action=images&mannCode=C%202646&mannCode=W%20930%2F20&width=600
 *   POST action=images
 *   GET  ?action=imageProxy&url=URL_CODIFICADA
 *   POST action=resolve
 *
 * POST /api/servicorFiltros?action=resolve
 * {
 *   "vehicleTypeId": "00000000191521",
 *   "productos": [
 *     {
 *       "codigo": "13541",
 *       "descripcion": "FILTRO ACEITE MANN W 712/73",
 *       "precio": 15800,
 *       "equivalencias": ["W 712/73"]
 *     }
 *   ]
 * }
 *
 * No necesita Express ni dependencias adicionales.
 * Usa fetch nativo de Node.js en Vercel.
 */

const MANN_ENDPOINT =
  "https://www.mann-filter.com/api/graphql/catalog-prod";

const MANN_ASSETS_ENDPOINT =
  "https://www.mann-filter.com/bin/assets.json";

const MANN_SCENE7_BASE =
  process.env.MANN_SCENE7_BASE ||
  "https://s7g10.scene7.com/is/image/mannhummel";

const MANN_SITE_BASE =
  process.env.MANN_SITE_BASE ||
  "https://www.mann-filter.com";

const MANN_STORE =
  process.env.MANN_STORE || "pcat_mf_ar_store_es";

const MANN_REFERER =
  process.env.MANN_REFERER ||
  "https://www.mann-filter.com/ar-es/catalogo.html";

const ALLOWED_ORIGINS = String(
  process.env.ALLOWED_ORIGINS || "*"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15000;

const FILTER_TYPES = new Set([
  "ALL_FILTER",
  "AIR_FILTER",
  "OIL_FILTER",
  "FUEL_FILTER",
  "CABIN_FILTER"
]);

const IGNORED_FILTER_CODES = new Set([
  "NOFILTER",
  "LIFETIMEFILTER"
]);

const IMAGE_PROXY_CACHE_SECONDS = clamp(
  positiveInteger(
    process.env.IMAGE_PROXY_CACHE_SECONDS,
    86400
  ),
  300,
  2592000
);

const MAX_IMAGE_PROXY_BYTES = clamp(
  positiveInteger(
    process.env.MAX_IMAGE_PROXY_BYTES,
    12 * 1024 * 1024
  ),
  1024,
  25 * 1024 * 1024
);

const IMAGE_PROBE_TIMEOUT_MS = clamp(
  positiveInteger(
    process.env.IMAGE_PROBE_TIMEOUT_MS,
    8000
  ),
  2000,
  15000
);

const QUERIES = {
  brands: `
    query($vehicleMake: String!) {
      brandSuggestion: brand_id_suggestion(search: $vehicleMake) {
        autoSuggestions: suggestions {
          suggestion_id: vehicle_brand_id
          suggestion_label: vehicle_brand_name
          suggestion_type: suggestion_zone
          suggestion_segment_id: vehicle_application_segment_id
          suggestion_category_id: vehicle_application_category_id
        }
      }
    }
  `,

  models: `
    query(
      $vehicleMakeId: String!
      $vehicleModel: String!
      $vehicleCategoryId: String
    ) {
      modelCollection: modelCollectionByBrandId(
        vehicle_brand_id: $vehicleMakeId
        model_name: $vehicleModel
        vehicle_category_id: $vehicleCategoryId
      ) {
        autoSuggestions: models {
          suggestion_id: model_series_id
          suggestion_label: model_series_name
          model_series_date
        }
      }
    }
  `,

  versions: `
    query($vehicleModelId: String!) {
      modelTypeCollection(
        model_series_id: $vehicleModelId
      ) {
        allModelTypes {
          bhp
          ccm
          engineCode: engine_code
          fuelType: fuel_type
          kw
          modelCode: model_code
          modelSeriesId: model_series_id
          modelSeriesName: model_series_name
          modelTypeId: model_type_id
          serialNumberRange: serial_number_range
          vehicleManufacturedFrom: vehicle_manufactured_from
          vehicleManufacturedTo: vehicle_manufactured_to
          vehicleName: vehicle_name
        }
      }
    }
  `,

  filters: `
    query(
      $vehicleTypeId: String!
      $filterBy: TYPE_OF_FILTER
      $currentPage: Int!
      $pageSize: Int!
    ) {
      catalogSearch: productLinkageCollection(
        vehicle_model_type_id: $vehicleTypeId
        filterBy: $filterBy
        currentPage: $currentPage
        pageSize: $pageSize
      ) {
        availableFilters: available_filters {
          label
          totalProducts: total_products
          code
        }

        items {
          productIdentifier: product_name
          product_type

          linkages {
            date_interval {
              linkage_fits_from
              linkage_fits_to
            }

            text {
              id
              module_name
              module_unit
              module_value
            }
          }

          product {
            sku
            urlKey: url_key
            name

            attributes: attributes_value {
              key
              value
              adminValue: admin_value
            }

            references {
              referenceTypeId: reference_type_id
              referenceTypeName: reference_type_name
              referenceTypeDescription: reference_type_description

              referenceProducts: reference_products {
                salesDesignation: sales_designation
                urlKey: url_key
              }
            }
          }
        }

        pageInfo: page_info {
          pageSize: page_size
          currentPage: current_page
          totalPages: total_pages
        }

        totalCount: total_count
      }
    }
  `
};

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido",
      allowedMethods: ["GET", "POST", "OPTIONS"]
    });
  }

  const action = getAction(req);

  try {
    switch (action) {
      case "health":
        return res.status(200).json({
          ok: true,
          service: "servicorFiltros",
          store: MANN_STORE,
          timestamp: new Date().toISOString()
        });

      case "brands":
        return await handleBrands(req, res);

      case "models":
        return await handleModels(req, res);

      case "versions":
        return await handleVersions(req, res);

      case "filters":
        return await handleFilters(req, res);

      case "images":
        return await handleImages(req, res);

      case "imageproxy":
        return await handleImageProxy(req, res);

      case "resolve":
        return await handleResolve(req, res);

      default:
        return res.status(400).json({
          ok: false,
          error: "Acción inválida",
          actions: [
            "health",
            "brands",
            "models",
            "versions",
            "filters",
            "images",
            "imageProxy",
            "resolve"
          ]
        });
    }
  } catch (error) {
    console.error("Error en servicorFiltros:", error);

    return res.status(error.statusCode || 500).json({
      ok: false,
      error:
        error.publicMessage ||
        "No se pudo consultar MANN-FILTER",
      detail: error.message
    });
  }
}

async function handleBrands(req, res) {
  const q = cleanString(getParam(req, "q"));

  if (q.length < 1) {
    return res.status(400).json({
      ok: false,
      error: "Ingresá al menos una letra en q"
    });
  }

  const data = await mannGraphql(
    QUERIES.brands,
    { vehicleMake: q },
    300
  );

  const raw =
    data?.brandSuggestion?.autoSuggestions || [];

  const brands = uniqueBy(
    raw
      .map((item) => ({
        id: cleanString(item?.suggestion_id),
        name: cleanString(item?.suggestion_label),
        zone: cleanString(item?.suggestion_type),
        segmentId: cleanString(
          item?.suggestion_segment_id
        ),
        categoryId: cleanString(
          item?.suggestion_category_id
        )
      }))
      .filter((item) => item.id && item.name),
    (item) =>
      [
        item.id,
        item.segmentId,
        item.categoryId
      ].join("|")
  );

  return res.status(200).json({
    ok: true,
    query: q,
    total: brands.length,
    brands
  });
}

async function handleModels(req, res) {
  const brandId = requireParam(req, "brandId");
  const q = cleanString(getParam(req, "q"));
  const categoryId = cleanString(
    getParam(req, "categoryId")
  );

  const data = await mannGraphql(
    QUERIES.models,
    {
      vehicleMakeId: brandId,
      vehicleModel: q,
      vehicleCategoryId: categoryId || null
    },
    900
  );

  const raw =
    data?.modelCollection?.autoSuggestions || [];

  const models = uniqueBy(
    raw
      .map((item) => ({
        id: cleanString(item?.suggestion_id),
        name: cleanString(item?.suggestion_label),
        date: cleanString(item?.model_series_date),
        label: buildModelLabel(item)
      }))
      .filter((item) => item.id && item.name),
    (item) => item.id
  );

  return res.status(200).json({
    ok: true,
    brandId,
    total: models.length,
    models
  });
}

async function handleVersions(req, res) {
  const modelId = requireParam(req, "modelId");

  const data = await mannGraphql(
    QUERIES.versions,
    { vehicleModelId: modelId },
    900
  );

  const raw =
    data?.modelTypeCollection?.allModelTypes || [];

  const versions = uniqueBy(
    raw
      .map(normalizeVersion)
      .filter((item) => item.vehicleTypeId),
    (item) => item.vehicleTypeId
  ).sort(compareVersions);

  return res.status(200).json({
    ok: true,
    modelId,
    total: versions.length,
    versions
  });
}

async function handleFilters(req, res) {
  const vehicleTypeId = requireParam(
    req,
    "vehicleTypeId"
  );

  const filterBy = normalizeFilterType(
    getParam(req, "filterBy")
  );

  const page = positiveInteger(
    getParam(req, "page"),
    1
  );

  const pageSize = clamp(
    positiveInteger(
      getParam(req, "pageSize"),
      DEFAULT_PAGE_SIZE
    ),
    1,
    MAX_PAGE_SIZE
  );

  const allPages =
    String(getParam(req, "allPages")).toLowerCase() !==
    "false";

  const catalog = allPages
    ? await getAllFilters(
        vehicleTypeId,
        filterBy,
        pageSize
      )
    : await getFilterPage(
        vehicleTypeId,
        filterBy,
        page,
        pageSize
      );

  return res.status(200).json({
    ok: true,
    vehicleTypeId,
    filterBy,
    total: catalog.filters.length,
    totalCount: catalog.totalCount,
    availableFilters: catalog.availableFilters,
    pageInfo: catalog.pageInfo,
    filters: catalog.filters
  });
}


async function handleImages(req, res) {
  const body = parseBody(req);

  const queryCodes = getRepeatedQueryParam(
    req,
    "mannCode"
  );

  const bodyCodes = [
    ...asArray(body.mannCodes),
    ...asArray(body.codes),
    ...asArray(body.productReferences)
  ];

  const singleBodyCode = cleanString(
    body.mannCode || body.code
  );

  const rawCodes = [
    ...queryCodes,
    ...bodyCodes,
    ...(singleBodyCode
      ? [singleBodyCode]
      : [])
  ];

  const mannCodes = uniqueStrings(
    rawCodes
      .flatMap((value) =>
        String(value || "")
          .split(",")
          .map((item) => item.trim())
      )
      .filter(Boolean)
      .filter(
        (mannCode) =>
          !isIgnoredFilterCode(mannCode)
      )
  );

  if (!mannCodes.length) {
    return res.status(400).json({
      ok: false,
      error:
        "Falta mannCode. Podés enviarlo varias veces en la URL o usar mannCodes en el cuerpo."
    });
  }

  const width = clamp(
    positiveInteger(
      getParam(req, "width") || body.width,
      600
    ),
    100,
    2000
  );

  const publicApiUrl = getPublicApiUrl(req);

  const images = await getMannImages(
    mannCodes,
    width,
    publicApiUrl
  );

  const found = [];
  const missing = [];

  for (const mannCode of mannCodes) {
    const image = images[mannCode];

    if (image?.imageUrl) {
      found.push(image);
    } else {
      missing.push(mannCode);
    }
  }

  return res.status(200).json({
    ok: true,
    width,
    requested: mannCodes.length,
    total: found.length,
    images,
    found,
    missing
  });
}

async function handleImageProxy(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error:
        "La acción imageProxy requiere una solicitud GET"
    });
  }

  const rawSourceUrl = firstNonEmpty([
    getParam(req, "url"),
    getParam(req, "src"),
    getParam(req, "source"),
    getParam(req, "imageUrl")
  ]);

  if (!rawSourceUrl) {
    return res.status(400).json({
      ok: false,
      error:
        "Falta la URL de la imagen en el parámetro url"
    });
  }

  const sourceUrl =
    validateRemoteImageUrl(rawSourceUrl);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response;

  try {
    response = await fetchAllowedRemote(
      sourceUrl,
      {
        method: "GET",
        headers: imageRequestHeaders(),
        signal: controller.signal,
        maxRedirects: 4
      }
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "La descarga de la imagen excedió el tiempo máximo"
      );
      timeoutError.statusCode = 504;
      timeoutError.publicMessage =
        "La imagen tardó demasiado en responder";
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = new Error(
      `El servidor de imágenes respondió HTTP ${response.status}`
    );
    error.statusCode =
      response.status === 404 ? 404 : 502;
    error.publicMessage =
      response.status === 404
        ? "La imagen no existe"
        : "No se pudo recuperar la imagen";
    throw error;
  }

  const contentType = normalizeContentType(
    response.headers.get("content-type")
  );

  const imageBuffer =
    await readResponseBufferLimited(
      response,
      MAX_IMAGE_PROXY_BYTES
    );

  if (!imageBuffer.length) {
    const error = new Error(
      "El servidor remoto devolvió una imagen vacía"
    );
    error.statusCode = 502;
    error.publicMessage =
      "La imagen recibida está vacía";
    throw error;
  }

  if (
    !contentType.startsWith("image/") &&
    !hasImageSignature(imageBuffer)
  ) {
    const error = new Error(
      `La URL no devolvió una imagen. Content-Type: ${
        contentType || "sin informar"
      }`
    );
    error.statusCode = 502;
    error.publicMessage =
      "El servidor remoto no devolvió una imagen válida";
    throw error;
  }

  const finalContentType =
    contentType.startsWith("image/")
      ? contentType
      : detectImageContentType(imageBuffer);

  console.log(
    "[MANN-IMG-SERVER] Imagen entregada por proxy",
    {
      sourceUrl,
      finalUrl: response.url,
      contentType: finalContentType,
      bytes: imageBuffer.length
    }
  );

  res.setHeader(
    "Content-Type",
    finalContentType || "image/jpeg"
  );
  res.setHeader(
    "Cache-Control",
    `public, max-age=${IMAGE_PROXY_CACHE_SECONDS}, s-maxage=${IMAGE_PROXY_CACHE_SECONDS}, stale-while-revalidate=604800`
  );
  res.setHeader(
    "X-Content-Type-Options",
    "nosniff"
  );
  res.setHeader(
    "Cross-Origin-Resource-Policy",
    "cross-origin"
  );

  const etag = cleanString(
    response.headers.get("etag")
  );

  if (etag) {
    res.setHeader("ETag", etag);
  }

  return res
    .status(200)
    .send(imageBuffer);
}

async function handleResolve(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error:
        "La acción resolve requiere una solicitud POST"
    });
  }

  const body = parseBody(req);
  const vehicleTypeId = cleanString(
    body.vehicleTypeId
  );

  if (!vehicleTypeId) {
    return res.status(400).json({
      ok: false,
      error: "Falta vehicleTypeId"
    });
  }

  const filterBy = normalizeFilterType(
    body.filterBy
  );

  const productos = Array.isArray(body.productos)
    ? body.productos
    : [];

  const equivalencias =
    body.equivalencias &&
    typeof body.equivalencias === "object"
      ? body.equivalencias
      : {};

  const catalog = await getAllFilters(
    vehicleTypeId,
    filterBy,
    DEFAULT_PAGE_SIZE
  );

  if (!productos.length) {
    return res.status(200).json({
      ok: true,
      vehicleTypeId,
      totalFiltros: catalog.filters.length,
      filters: catalog.filters,
      productos: [],
      sinEquivalencia: catalog.filters,
      warning:
        "No se recibió productos. Se devolvieron los filtros MANN sin normalizar contra precios."
    });
  }

  const index = buildProductIndex(
    productos,
    equivalencias
  );

  const matched = [];
  const unmatched = [];
  const ambiguous = [];

  for (const filter of catalog.filters) {
    const result = resolveFilter(filter, index);

    if (result.status === "matched") {
      matched.push({
        ...toBudgetProduct(
          result.product,
          filter
        ),
        match: {
          mannCode: filter.mannCode,
          normalizedMannCode:
            result.normalizedCode,
          source: result.source
        }
      });
    } else if (result.status === "ambiguous") {
      ambiguous.push({
        filter,
        normalizedCode: result.normalizedCode,
        candidates: result.products
      });
    } else {
      unmatched.push(filter);
    }
  }

  return res.status(200).json({
    ok: true,
    vehicleTypeId,
    totalFiltros: catalog.filters.length,
    totalProductos: matched.length,
    productos: matched,
    sinEquivalencia: unmatched,
    ambiguos: ambiguous,
    availableFilters: catalog.availableFilters
  });
}

async function getAllFilters(
  vehicleTypeId,
  filterBy,
  pageSize
) {
  const first = await getFilterPage(
    vehicleTypeId,
    filterBy,
    1,
    pageSize
  );

  const totalPages = Math.max(
    1,
    Number(first.pageInfo?.totalPages || 1)
  );

  if (totalPages === 1) {
    return first;
  }

  const filters = [...first.filters];

  for (let page = 2; page <= totalPages; page++) {
    const next = await getFilterPage(
      vehicleTypeId,
      filterBy,
      page,
      pageSize
    );

    filters.push(...next.filters);
  }

  return {
    filters: uniqueBy(
      filters,
      (item) =>
        [
          item.normalizedCode,
          item.type,
          item.sku
        ].join("|")
    ),
    availableFilters: first.availableFilters,
    totalCount: first.totalCount,
    pageInfo: {
      pageSize,
      currentPage: 1,
      totalPages
    }
  };
}

async function getFilterPage(
  vehicleTypeId,
  filterBy,
  currentPage,
  pageSize
) {
  const data = await mannGraphql(
    QUERIES.filters,
    {
      vehicleTypeId,
      filterBy,
      currentPage,
      pageSize
    },
    300
  );

  const catalog = data?.catalogSearch;

  if (!catalog) {
    const error = new Error(
      "La respuesta de MANN no contiene catalogSearch"
    );
    error.statusCode = 502;
    throw error;
  }

  const filters = Array.isArray(catalog.items)
    ? catalog.items
        .map(normalizeFilter)
        .filter(isValidMannFilter)
    : [];

  return {
    filters,
    availableFilters: Array.isArray(
      catalog.availableFilters
    )
      ? catalog.availableFilters.map((item) => ({
          label: cleanString(item?.label),
          code: cleanString(item?.code),
          totalProducts: Number(
            item?.totalProducts || 0
          )
        }))
      : [],
    pageInfo: {
      pageSize: Number(
        catalog.pageInfo?.pageSize || pageSize
      ),
      currentPage: Number(
        catalog.pageInfo?.currentPage ||
          currentPage
      ),
      totalPages: Number(
        catalog.pageInfo?.totalPages || 1
      )
    },
    totalCount: Number(
      catalog.totalCount || filters.length
    )
  };
}


async function getMannImages(
  mannCodes,
  width = 600,
  publicApiUrl = ""
) {
  const uniqueCodes = uniqueStrings(
    mannCodes
      .map(cleanString)
      .filter(Boolean)
      .filter(
        (mannCode) =>
          !isIgnoredFilterCode(mannCode)
      )
  );

  if (!uniqueCodes.length) {
    return {};
  }

  const strictHits = [];

  for (const batch of chunkArray(uniqueCodes, 20)) {
    try {
      const hits = await fetchMannAssetBatch(
        batch,
        { relaxed: false }
      );
      strictHits.push(...hits);
    } catch (error) {
      console.warn(
        "[MANN-IMG-SERVER] Falló la consulta estricta de assets",
        {
          batch,
          message: error?.message
        }
      );
    }
  }

  const result = {};
  const unresolved = [];

  await mapWithConcurrency(
    uniqueCodes,
    4,
    async (mannCode) => {
      const resolved =
        await resolveImageFromAssetHits(
          strictHits,
          mannCode,
          width,
          "assets-api"
        );

      if (resolved) {
        result[mannCode] =
          proxifyImageResult(
            resolved,
            publicApiUrl
          );
      } else {
        unresolved.push(mannCode);
      }
    }
  );

  let relaxedHits = [];

  if (unresolved.length) {
    for (
      const batch of chunkArray(
        unresolved,
        12
      )
    ) {
      try {
        const hits =
          await fetchMannAssetBatch(
            batch,
            { relaxed: true }
          );

        relaxedHits.push(...hits);
      } catch (error) {
        console.warn(
          "[MANN-IMG-SERVER] Falló la consulta ampliada de assets",
          {
            batch,
            message: error?.message
          }
        );
      }
    }
  }

  await mapWithConcurrency(
    unresolved,
    3,
    async (mannCode) => {
      let resolved =
        await resolveImageFromAssetHits(
          relaxedHits,
          mannCode,
          width,
          "assets-api-relaxed"
        );

      if (!resolved) {
        resolved =
          await resolveImageFromProductPage(
            mannCode,
            width
          );
      }

      if (!resolved) {
        resolved =
          await resolveScene7Fallback(
            mannCode,
            width
          );
      }

      if (resolved) {
        result[mannCode] =
          proxifyImageResult(
            resolved,
            publicApiUrl
          );

        console.log(
          "[MANN-IMG-SERVER] Imagen resuelta",
          {
            mannCode,
            source: resolved.source,
            sourceImageUrl:
              resolved.sourceImageUrl
          }
        );

        return;
      }

      const scene7Candidates =
        buildScene7AssetCandidates(
          mannCode
        );

      result[mannCode] = {
        mannCode,
        found: false,
        imageUrl: "",
        sourceImageUrl: "",
        source: "missing",
        scene7Candidates
      };

      console.warn(
        "[MANN-IMG-SERVER] No se encontró una imagen válida",
        {
          mannCode,
          scene7Candidates
        }
      );
    }
  );

  return result;
}

async function fetchMannAssetBatch(
  mannCodes,
  { relaxed = false } = {}
) {
  const url = new URL(MANN_ASSETS_ENDPOINT);

  url.searchParams.set("metaData", "true");
  url.searchParams.set(
    "brand",
    "MANN-FILTER"
  );

  if (!relaxed) {
    url.searchParams.set(
      "productView",
      "Front"
    );
    url.searchParams.set(
      "productDimensionAsset",
      "No"
    );
    url.searchParams.set(
      "productRelatedAssetType",
      "Product Image"
    );
    url.searchParams.set(
      "mainImage",
      "true"
    );
  }

  for (const mannCode of mannCodes) {
    const reference =
      buildMannProductReference(mannCode);

    if (reference) {
      url.searchParams.append(
        "productReferences",
        reference
      );
    }
  }

  url.searchParams.set(
    "limit",
    String(
      relaxed
        ? Math.max(60, mannCodes.length * 15)
        : Math.max(25, mannCodes.length * 5)
    )
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response;

  try {
    response = await fetch(
      url.toString(),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Referer: MANN_REFERER,
          "User-Agent":
            "Mozilla/5.0 (compatible; Boxes-MANN-Service/2.0)"
        },
        signal: controller.signal
      }
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "La consulta de imágenes a MANN excedió el tiempo máximo"
      );
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(
      `MANN Assets respondió HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
    error.statusCode = 502;
    throw error;
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error(
      "MANN Assets no devolvió un JSON válido"
    );
    error.statusCode = 502;
    throw error;
  }

  if (payload?.successful === false) {
    const error = new Error(
      cleanString(payload?.reason) ||
        "MANN Assets rechazó la consulta"
    );
    error.statusCode = 502;
    throw error;
  }

  return arrayify(payload?.hits);
}

async function resolveImageFromAssetHits(
  hits,
  mannCode,
  width,
  source
) {
  const matchingHits =
    getMatchingAssetHits(
      hits,
      mannCode
    );

  for (const hit of matchingHits) {
    const candidates =
      buildAssetHitCandidates(
        hit,
        width
      );

    for (const candidate of candidates) {
      const probe = await probeRemoteImage(
        candidate.url
      );

      if (!probe.ok) {
        continue;
      }

      return {
        mannCode,
        found: true,
        source,
        sourceField:
          candidate.sourceField,
        sourceImageUrl:
          probe.finalUrl ||
          candidate.url,
        imageUrl:
          probe.finalUrl ||
          candidate.url,
        uriTemplate: cleanString(
          hit?.uriTemplate
        ),
        link: cleanString(hit?.link),
        mimeType:
          probe.contentType ||
          cleanString(hit?.mimeType),
        width: numberOrNull(
          hit?.dimension?.width
        ),
        height: numberOrNull(
          hit?.dimension?.height
        ),
        title: firstNonEmpty([
          hit?.metaData?.["jcr:title"],
          hit?.metaData?.["dc:title"]
        ]),
        productView: cleanString(
          hit?.metaData?.productView
        ),
        mainImage: isTrueValue(
          hit?.metaData?.mainImage
        ),
        scene7File:
          candidate.scene7File ||
          cleanString(
            hit?.metaData?.[
              "dam:scene7File"
            ]
          ),
        productReferences:
          arrayify(
            hit?.metaData
              ?.productReferences
          )
      };
    }
  }

  return null;
}

function getMatchingAssetHits(
  hits,
  mannCode
) {
  const target =
    normalizeAssetReference(mannCode);

  return arrayify(hits)
    .filter((hit) => {
      const references = arrayify(
        hit?.metaData?.productReferences
      ).flatMap((reference) =>
        String(reference || "")
          .split(",")
      );

      return references.some(
        (reference) =>
          normalizeAssetReference(
            reference
          ) === target
      );
    })
    .sort(
      (a, b) =>
        scoreAssetHit(b, mannCode) -
        scoreAssetHit(a, mannCode)
    );
}

function scoreAssetHit(
  hit,
  mannCode
) {
  let score = 0;

  if (
    isTrueValue(
      hit?.metaData?.mainImage
    )
  ) {
    score += 50;
  }

  if (
    cleanString(
      hit?.metaData?.productView
    ).toLowerCase() === "front"
  ) {
    score += 35;
  }

  const text = [
    hit?.uriTemplate,
    hit?.link,
    hit?.metaData?.[
      "dam:scene7File"
    ],
    hit?.metaData?.["jcr:title"],
    hit?.metaData?.["dc:title"]
  ]
    .map(cleanString)
    .join(" ")
    .toLowerCase();

  if (
    text.includes(
      "filter-with-box"
    )
  ) {
    score += 30;
  }

  const target =
    normalizeAssetReference(mannCode);

  if (
    normalizeAssetReference(text)
      .includes(target)
  ) {
    score += 20;
  }

  if (
    cleanString(
      hit?.metaData
        ?.productRelatedAssetType
    )
      .toLowerCase()
      .includes("product image")
  ) {
    score += 10;
  }

  return score;
}

function buildAssetHitCandidates(
  hit,
  width
) {
  const candidates = [];

  const add = (
    value,
    sourceField,
    scene7File = ""
  ) => {
    const url = normalizeCandidateImageUrl(
      value,
      width
    );

    if (!url) return;

    candidates.push({
      url,
      sourceField,
      scene7File
    });
  };

  const uriTemplate = cleanString(
    hit?.uriTemplate
  );

  if (uriTemplate) {
    add(
      uriTemplate.replace(
        /\{width\}/gi,
        String(width)
      ),
      "uriTemplate"
    );
  }

  const scene7File = cleanString(
    hit?.metaData?.["dam:scene7File"]
  );

  const scene7Domain = cleanString(
    hit?.metaData?.[
      "dam:scene7Domain"
    ]
  );

  if (scene7File) {
    add(
      buildScene7ImageUrl(
        scene7File,
        width,
        scene7Domain ||
          MANN_SCENE7_BASE
      ),
      "dam:scene7File",
      scene7File
    );
  }

  [
    ["link", hit?.link],
    [
      "dam:scene7URL",
      hit?.metaData?.[
        "dam:scene7URL"
      ]
    ],
    [
      "dc:source",
      hit?.metaData?.["dc:source"]
    ],
    ["url", hit?.url]
  ].forEach(([sourceField, value]) => {
    add(value, sourceField);
  });

  return uniqueBy(
    candidates,
    (candidate) => candidate.url
  );
}

async function resolveImageFromProductPage(
  mannCode,
  width
) {
  const pageUrls =
    buildMannProductPageUrls(
      mannCode
    );

  for (const productPageUrl of pageUrls) {
    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    let response;

    try {
      response =
        await fetchAllowedRemote(
          productPageUrl,
          {
            method: "GET",
            headers: {
              Accept:
                "text/html,application/xhtml+xml",
              "Accept-Language":
                "es-AR,es;q=0.9,en;q=0.7",
              Referer: MANN_REFERER,
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
            },
            signal: controller.signal,
            maxRedirects: 4
          }
        );
    } catch (error) {
      if (error?.name !== "AbortError") {
        console.warn(
          "[MANN-IMG-SERVER] No se pudo leer la ficha del producto",
          {
            mannCode,
            productPageUrl,
            message: error?.message
          }
        );
      }

      clearTimeout(timeout);
      continue;
    }

    clearTimeout(timeout);

    if (!response.ok) {
      continue;
    }

    const contentType =
      normalizeContentType(
        response.headers.get(
          "content-type"
        )
      );

    if (
      contentType &&
      !contentType.includes("html")
    ) {
      continue;
    }

    const html = await response.text();

    const candidates =
      extractImageCandidatesFromHtml(
        html,
        response.url ||
          productPageUrl,
        mannCode,
        width
      );

    for (const candidate of candidates) {
      const probe =
        await probeRemoteImage(
          candidate.url
        );

      if (!probe.ok) {
        continue;
      }

      return {
        mannCode,
        found: true,
        source: "product-page",
        sourceField:
          candidate.sourceField,
        sourceImageUrl:
          probe.finalUrl ||
          candidate.url,
        imageUrl:
          probe.finalUrl ||
          candidate.url,
        uriTemplate: "",
        link: response.url ||
          productPageUrl,
        mimeType: probe.contentType,
        width: null,
        height: null,
        title: `Filtro MANN ${mannCode}`,
        productView: "Front",
        mainImage: true,
        scene7File:
          getScene7FileFromUrl(
            probe.finalUrl ||
              candidate.url
          ),
        productReferences: [
          buildMannProductReference(
            mannCode
          )
        ],
        productPageUrl:
          response.url ||
          productPageUrl
      };
    }
  }

  return null;
}

function buildMannProductPageUrls(
  mannCode
) {
  const cleanCode = cleanString(
    mannCode
  )
    .replace(
      /_MANN-FILTER$/i,
      ""
    )
    .replace(/\s+/g, "")
    .toLowerCase();

  if (!cleanCode) {
    return [];
  }

  const slug = cleanCode
    .split("/")
    .map((part) =>
      encodeURIComponent(part)
    )
    .join("/");

  const base =
    MANN_SITE_BASE.replace(
      /\/+$/,
      ""
    );

  return [
    `${base}/ar-es/catalogo/resultados-de-busqueda/producto.html/${slug}_mann-filter.html`,
    `${base}/en/catalog/search-results/product.html/${slug}_mann-filter.html`
  ];
}

function extractImageCandidatesFromHtml(
  html,
  baseUrl,
  mannCode,
  width
) {
  const decoded = decodeHtml(
    String(html || "")
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\u002f/gi, "/")
  );

  const found = [];

  const add = (
    value,
    sourceField
  ) => {
    const raw = cleanString(value);

    if (!raw) return;

    const pieces =
      sourceField === "srcset"
        ? raw
            .split(",")
            .map((piece) =>
              piece
                .trim()
                .split(/\s+/)[0]
            )
        : [raw];

    for (const piece of pieces) {
      let absolute;

      try {
        absolute = new URL(
          piece,
          baseUrl
        ).toString();
      } catch {
        continue;
      }

      if (
        !isPotentialImageUrl(
          absolute
        )
      ) {
        continue;
      }

      const url =
        normalizeCandidateImageUrl(
          absolute,
          width
        );

      if (url) {
        found.push({
          url,
          sourceField
        });
      }
    }
  };

  const absoluteUrlRegex =
    /https?:\/\/[^\s"'<>\\]+/gi;

  for (
    const match of decoded.matchAll(
      absoluteUrlRegex
    )
  ) {
    add(match[0], "html-url");
  }

  const attributeRegex =
    /\b(?:src|data-src|data-lazy-src|content)\s*=\s*["']([^"']+)["']/gi;

  for (
    const match of decoded.matchAll(
      attributeRegex
    )
  ) {
    add(match[1], "html-attribute");
  }

  const srcsetRegex =
    /\bsrcset\s*=\s*["']([^"']+)["']/gi;

  for (
    const match of decoded.matchAll(
      srcsetRegex
    )
  ) {
    add(match[1], "srcset");
  }

  return uniqueBy(
    found,
    (candidate) => candidate.url
  )
    .sort(
      (a, b) =>
        scorePageImageCandidate(
          b.url,
          mannCode
        ) -
        scorePageImageCandidate(
          a.url,
          mannCode
        )
    )
    .slice(0, 25);
}

function scorePageImageCandidate(
  imageUrl,
  mannCode
) {
  const normalizedUrl =
    normalizeAssetReference(
      decodeURIComponentSafe(
        imageUrl
      )
    );

  const normalizedCode =
    normalizeAssetReference(
      mannCode
    );

  const lower =
    String(imageUrl).toLowerCase();

  let score = 0;

  if (
    normalizedUrl.includes(
      normalizedCode
    )
  ) {
    score += 100;
  }

  if (
    lower.includes(
      "filter-with-box"
    )
  ) {
    score += 40;
  }

  if (
    lower.includes(
      "/is/image/"
    )
  ) {
    score += 30;
  }

  if (
    lower.includes("product")
  ) {
    score += 10;
  }

  if (
    /(?:logo|favicon|icon|banner|teaser|main-visual|placeholder|no-image)/i.test(
      lower
    ) &&
    !normalizedUrl.includes(
      normalizedCode
    )
  ) {
    score -= 100;
  }

  return score;
}

async function resolveScene7Fallback(
  mannCode,
  width
) {
  const candidates =
    buildScene7AssetCandidates(
      mannCode
    );

  const checks =
    await mapWithConcurrency(
      candidates,
      4,
      async (scene7File) => {
        const imageUrl =
          buildScene7ImageUrl(
            scene7File,
            width
          );

        const probe =
          await probeRemoteImage(
            imageUrl
          );

        return {
          scene7File,
          imageUrl,
          probe
        };
      }
    );

  const match = checks.find(
    (check) => check?.probe?.ok
  );

  if (!match) {
    return null;
  }

  return {
    mannCode,
    found: true,
    source: "scene7-fallback",
    sourceField:
      "generated-scene7-candidate",
    sourceImageUrl:
      match.probe.finalUrl ||
      match.imageUrl,
    imageUrl:
      match.probe.finalUrl ||
      match.imageUrl,
    uriTemplate: "",
    link: "",
    mimeType:
      match.probe.contentType ||
      "image/jpeg",
    width: null,
    height: null,
    title: `Filtro MANN ${mannCode}`,
    productView: "Front",
    mainImage: true,
    scene7File:
      match.scene7File,
    productReferences: [
      buildMannProductReference(
        mannCode
      )
    ],
    scene7Candidates: candidates
  };
}

function buildScene7AssetCandidates(
  mannCode
) {
  const code = cleanString(
    mannCode
  )
    .toUpperCase()
    .replace(
      /_MANN-FILTER$/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  const match = code.match(
    /^([A-Z]+)\s*(.+)$/
  );

  if (!match) {
    return [];
  }

  const prefix = match[1];
  const remainder = match[2]
    .trim();

  const compact = remainder
    .replace(/\s+/g, "");

  const dotSlash = compact
    .replace(/\//g, ".");

  const spacedUnderscore =
    remainder
      .replace(/\//g, ".")
      .replace(/\s+/g, "_");

  const splitTrailingLetter =
    dotSlash.replace(
      /(\d)([A-Z])$/i,
      "$1_$2"
    );

  const baseVariants = [
    `${prefix}_${spacedUnderscore}`,
    `${prefix}_${splitTrailingLetter}`,
    `${prefix}_${dotSlash}`,
    `${prefix}${dotSlash}`
  ];

  if (
    prefix === "C" &&
    /^\d{5}$/.test(compact)
  ) {
    baseVariants.unshift(
      `C_${compact.slice(0, 2)}_${compact.slice(2)}`
    );
  }

  if (
    prefix === "HU" &&
    /_X$/i.test(
      `${prefix}_${splitTrailingLetter}`
    )
  ) {
    baseVariants.unshift(
      `${prefix}_${splitTrailingLetter}`
        .replace(/_X$/i, "_x")
    );
  }

  const cleanBases = uniqueStrings(
    baseVariants.map((value) =>
      value
        .replace(/\.{2,}/g, ".")
        .replace(/_{2,}/g, "_")
        .replace(
          /^[._-]+|[._-]+$/g,
          ""
        )
    )
  );

  const candidates = [];

  for (const base of cleanBases) {
    candidates.push(
      `${base}-filter-with-box`,
      `${base}-1`,
      base,
      `${base}-filter`
    );

    if (/_X(?:-|$)/.test(base)) {
      const lowerX =
        base.replace(
          /_X(?:$)/,
          "_x"
        );

      candidates.push(
        `${lowerX}-filter-with-box`,
        `${lowerX}-1`,
        lowerX
      );
    }
  }

  return uniqueStrings(candidates)
    .slice(0, 32);
}

function normalizeCandidateImageUrl(
  value,
  width
) {
  const raw = cleanString(value);

  if (!raw) return "";

  let url;

  try {
    url = new URL(
      raw,
      MANN_REFERER
    );
  } catch {
    return "";
  }

  if (
    !isAllowedRemoteHost(
      url.hostname
    )
  ) {
    return "";
  }

  if (
    url.pathname.includes(
      "/is/image/"
    )
  ) {
    url.searchParams.set(
      "wid",
      String(width)
    );
    url.searchParams.set(
      "fit",
      "constrain"
    );

    if (
      !url.searchParams.has("qlt")
    ) {
      url.searchParams.set(
        "qlt",
        "82"
      );
    }

    if (
      !url.searchParams.has("dpr")
    ) {
      url.searchParams.set(
        "dpr",
        "off"
      );
    }
  }

  return url.toString();
}

function buildScene7ImageUrl(
  scene7File,
  width,
  baseUrl = MANN_SCENE7_BASE
) {
  const normalizedBase =
    normalizeScene7BaseUrl(
      baseUrl
    );

  const normalizedFile =
    normalizeScene7FileForBase(
      scene7File,
      normalizedBase
    );

  if (!normalizedFile) {
    return "";
  }

  const encodedFile = normalizedFile
    .split("/")
    .map((part) =>
      encodeURIComponent(part)
    )
    .join("/");

  const url = new URL(
    `${normalizedBase.replace(
      /\/+$/,
      ""
    )}/${encodedFile}`
  );

  url.searchParams.set(
    "wid",
    String(width)
  );
  url.searchParams.set(
    "fit",
    "constrain"
  );
  url.searchParams.set(
    "qlt",
    "82"
  );
  url.searchParams.set(
    "dpr",
    "off"
  );

  return url.toString();
}

function normalizeScene7BaseUrl(
  value
) {
  const fallback =
    MANN_SCENE7_BASE.replace(
      /\/+$/,
      ""
    );

  const raw = cleanString(value);

  if (!raw) {
    return fallback;
  }

  let url;

  try {
    url = new URL(raw);
  } catch {
    return fallback;
  }

  const path =
    url.pathname.replace(
      /\/+$/,
      ""
    );

  if (
    /\/is\/image\/[^/]+$/i.test(
      path
    )
  ) {
    url.pathname = path;
    url.search = "";
    return url.toString()
      .replace(/\/+$/, "");
  }

  if (
    /\/is\/image$/i.test(path)
  ) {
    url.pathname =
      `${path}/mannhummel`;
    url.search = "";
    return url.toString()
      .replace(/\/+$/, "");
  }

  url.pathname =
    `${path}/is/image/mannhummel`
      .replace(/\/{2,}/g, "/");
  url.search = "";

  return url.toString()
    .replace(/\/+$/, "");
}

function normalizeScene7FileForBase(
  scene7File,
  baseUrl
) {
  let file = cleanString(
    scene7File
  ).replace(/^\/+/, "");

  if (!file) {
    return "";
  }

  try {
    const base = new URL(baseUrl);
    const parts = base.pathname
      .split("/")
      .filter(Boolean);

    const company =
      parts[parts.length - 1];

    if (
      company &&
      file.toLowerCase().startsWith(
        `${company.toLowerCase()}/`
      )
    ) {
      file =
        file.slice(
          company.length + 1
        );
    }
  } catch {
    // Se conserva el nombre del archivo.
  }

  return file;
}

async function probeRemoteImage(
  sourceUrl
) {
  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    IMAGE_PROBE_TIMEOUT_MS
  );

  let response;

  try {
    response =
      await fetchAllowedRemote(
        sourceUrl,
        {
          method: "GET",
          headers: {
            ...imageRequestHeaders(),
            Range: "bytes=0-4095"
          },
          signal: controller.signal,
          maxRedirects: 4
        }
      );
  } catch {
    clearTimeout(timeout);

    return {
      ok: false,
      finalUrl: "",
      contentType: ""
    };
  }

  clearTimeout(timeout);

  if (!response.ok) {
    cancelResponseBody(response);

    return {
      ok: false,
      finalUrl: response.url,
      contentType:
        normalizeContentType(
          response.headers.get(
            "content-type"
          )
        ),
      status: response.status
    };
  }

  const contentType =
    normalizeContentType(
      response.headers.get(
        "content-type"
      )
    );

  const firstChunk =
    await readFirstResponseChunk(
      response
    );

  const valid =
    (
      contentType.startsWith(
        "image/"
      ) ||
      hasImageSignature(
        firstChunk
      )
    ) &&
    firstChunk.length > 0;

  return {
    ok: valid,
    finalUrl:
      response.url ||
      sourceUrl,
    contentType,
    status: response.status
  };
}

async function fetchAllowedRemote(
  sourceUrl,
  {
    method = "GET",
    headers = {},
    signal,
    maxRedirects = 4
  } = {}
) {
  let currentUrl =
    validateRemoteImageUrl(
      sourceUrl
    );

  for (
    let redirectCount = 0;
    redirectCount <= maxRedirects;
    redirectCount += 1
  ) {
    const response = await fetch(
      currentUrl,
      {
        method,
        headers,
        signal,
        redirect: "manual"
      }
    );

    if (
      !isRedirectStatus(
        response.status
      )
    ) {
      return response;
    }

    if (
      redirectCount ===
      maxRedirects
    ) {
      cancelResponseBody(response);

      const error = new Error(
        "La URL superó el máximo de redirecciones"
      );
      error.statusCode = 502;
      throw error;
    }

    const location = cleanString(
      response.headers.get(
        "location"
      )
    );

    cancelResponseBody(response);

    if (!location) {
      const error = new Error(
        "La redirección no informó una ubicación"
      );
      error.statusCode = 502;
      throw error;
    }

    currentUrl =
      validateRemoteImageUrl(
        new URL(
          location,
          currentUrl
        ).toString()
      );
  }

  throw new Error(
    "No se pudo resolver la URL remota"
  );
}

function validateRemoteImageUrl(
  value
) {
  let url;

  try {
    url = new URL(
      cleanString(value)
    );
  } catch {
    const error = new Error(
      "La URL de imagen no es válida"
    );
    error.statusCode = 400;
    error.publicMessage =
      "La URL de imagen no es válida";
    throw error;
  }

  if (url.protocol !== "https:") {
    const error = new Error(
      "Solo se permiten imágenes mediante HTTPS"
    );
    error.statusCode = 400;
    error.publicMessage =
      "La URL de imagen no está permitida";
    throw error;
  }

  if (
    !isAllowedRemoteHost(
      url.hostname
    )
  ) {
    const error = new Error(
      `Dominio de imagen no permitido: ${url.hostname}`
    );
    error.statusCode = 403;
    error.publicMessage =
      "El dominio de la imagen no está permitido";
    throw error;
  }

  return url.toString();
}

function isAllowedRemoteHost(
  hostname
) {
  const host = cleanString(
    hostname
  ).toLowerCase();

  return (
    host === "mann-filter.com" ||
    host.endsWith(
      ".mann-filter.com"
    ) ||
    host === "scene7.com" ||
    host.endsWith(
      ".scene7.com"
    )
  );
}

function isRedirectStatus(status) {
  return [
    301,
    302,
    303,
    307,
    308
  ].includes(Number(status));
}

function imageRequestHeaders() {
  return {
    Accept:
      "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    Referer: MANN_REFERER,
    "Accept-Language":
      "es-AR,es;q=0.9,en;q=0.7",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
  };
}

async function readFirstResponseChunk(
  response
) {
  if (!response?.body) {
    return Buffer.alloc(0);
  }

  const reader =
    response.body.getReader();

  try {
    const { value } =
      await reader.read();

    return value
      ? Buffer.from(value)
      : Buffer.alloc(0);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // La respuesta ya puede estar cerrada.
    }
  }
}

async function readResponseBufferLimited(
  response,
  maxBytes
) {
  if (!response?.body) {
    return Buffer.alloc(0);
  }

  const announcedLength = Number(
    response.headers.get(
      "content-length"
    ) || 0
  );

  if (
    Number.isFinite(
      announcedLength
    ) &&
    announcedLength > maxBytes
  ) {
    const error = new Error(
      `La imagen supera el máximo permitido de ${maxBytes} bytes`
    );
    error.statusCode = 413;
    error.publicMessage =
      "La imagen es demasiado grande";
    throw error;
  }

  const reader =
    response.body.getReader();

  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } =
        await reader.read();

      if (done) break;

      if (!value?.length) {
        continue;
      }

      total += value.length;

      if (total > maxBytes) {
        const error = new Error(
          `La imagen descargada supera el máximo permitido de ${maxBytes} bytes`
        );
        error.statusCode = 413;
        error.publicMessage =
          "La imagen es demasiado grande";
        throw error;
      }

      chunks.push(
        Buffer.from(value)
      );
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // La respuesta ya puede estar cerrada.
    }
  }

  return Buffer.concat(
    chunks,
    total
  );
}

function cancelResponseBody(
  response
) {
  try {
    response?.body?.cancel();
  } catch {
    // No es necesario hacer nada.
  }
}

function normalizeContentType(
  value
) {
  return cleanString(value)
    .toLowerCase()
    .split(";")[0]
    .trim();
}

function hasImageSignature(
  value
) {
  const buffer = Buffer.isBuffer(
    value
  )
    ? value
    : Buffer.from(value || []);

  if (buffer.length < 4) {
    return false;
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return true;
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a
      ])
    )
  ) {
    return true;
  }

  if (
    buffer.subarray(0, 4)
      .toString("ascii") === "GIF8"
  ) {
    return true;
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4)
      .toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12)
      .toString("ascii") === "WEBP"
  ) {
    return true;
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 12)
      .toString("ascii")
      .includes("ftyp")
  ) {
    return true;
  }

  const text = buffer
    .subarray(0, 512)
    .toString("utf8")
    .trim()
    .toLowerCase();

  return (
    text.startsWith("<svg") ||
    text.startsWith("<?xml") &&
      text.includes("<svg")
  );
}

function detectImageContentType(
  buffer
) {
  if (!buffer?.length) {
    return "";
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(
      Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a
      ])
    )
  ) {
    return "image/png";
  }

  if (
    buffer.subarray(0, 4)
      .toString("ascii") === "GIF8"
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4)
      .toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12)
      .toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const text = buffer
    .subarray(0, 512)
    .toString("utf8")
    .trim()
    .toLowerCase();

  if (
    text.startsWith("<svg") ||
    text.startsWith("<?xml") &&
      text.includes("<svg")
  ) {
    return "image/svg+xml";
  }

  return "image/jpeg";
}

function proxifyImageResult(
  image,
  publicApiUrl
) {
  const sourceImageUrl =
    cleanString(
      image?.sourceImageUrl ||
      image?.imageUrl
    );

  if (!sourceImageUrl) {
    return {
      ...image,
      found: false,
      imageUrl: ""
    };
  }

  const imageUrl =
    buildImageProxyUrl(
      publicApiUrl,
      sourceImageUrl
    ) ||
    sourceImageUrl;

  return {
    ...image,
    found: true,
    sourceImageUrl,
    imageUrl,
    proxied:
      imageUrl !== sourceImageUrl
  };
}

function buildImageProxyUrl(
  publicApiUrl,
  sourceImageUrl
) {
  const base = cleanString(
    publicApiUrl
  );

  if (!base) {
    return "";
  }

  try {
    const url = new URL(base);
    url.search = "";
    url.searchParams.set(
      "action",
      "imageProxy"
    );
    url.searchParams.set(
      "url",
      sourceImageUrl
    );
    return url.toString();
  } catch {
    return "";
  }
}

function getPublicApiUrl(req) {
  const forwardedProto =
    cleanString(
      req?.headers?.[
        "x-forwarded-proto"
      ]
    )
      .split(",")[0]
      .trim();

  const protocol =
    forwardedProto ||
    (
      req?.headers?.[
        "x-forwarded-ssl"
      ] === "on"
        ? "https"
        : "https"
    );

  const forwardedHost =
    cleanString(
      req?.headers?.[
        "x-forwarded-host"
      ]
    )
      .split(",")[0]
      .trim();

  const host =
    forwardedHost ||
    cleanString(
      req?.headers?.host
    );

  if (!host) {
    return "";
  }

  const requestUrl =
    cleanString(req?.url) ||
    "/api/servicorFiltros";

  try {
    const url = new URL(
      requestUrl,
      `${protocol}://${host}`
    );

    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return "";
  }
}

function isPotentialImageUrl(
  value
) {
  try {
    const url = new URL(value);

    if (
      !isAllowedRemoteHost(
        url.hostname
      )
    ) {
      return false;
    }

    return (
      url.pathname.includes(
        "/is/image/"
      ) ||
      /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}

function getScene7FileFromUrl(
  value
) {
  try {
    const url = new URL(value);
    const marker =
      "/is/image/";

    const index =
      url.pathname.indexOf(marker);

    if (index < 0) {
      return "";
    }

    const remaining =
      decodeURIComponent(
        url.pathname.slice(
          index + marker.length
        )
      );

    const parts = remaining
      .split("/")
      .filter(Boolean);

    if (parts.length <= 1) {
      return parts[0] || "";
    }

    return parts.slice(1)
      .join("/");
  } catch {
    return "";
  }
}

function buildMannProductReference(
  mannCode
) {
  const code = cleanString(
    mannCode
  )
    .toUpperCase()
    .replace(/\s+/g, "");

  return code
    ? `${code}_MANN-FILTER`
    : "";
}

function normalizeAssetReference(
  value = ""
) {
  return String(value)
    .toUpperCase()
    .replace(
      /_MANN-FILTER$/i,
      ""
    )
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function isTrueValue(value) {
  return (
    value === true ||
    String(value)
      .toLowerCase() === "true"
  );
}

function isIgnoredFilterCode(
  value
) {
  return IGNORED_FILTER_CODES.has(
    normalizeFilterCode(value)
  );
}

function isValidMannFilter(
  filter
) {
  const code =
    normalizeFilterCode(
      firstNonEmpty([
        filter?.mannCode,
        filter?.name,
        filter?.productIdentifier,
        filter?.sku
      ])
    );

  return (
    Boolean(code) &&
    !IGNORED_FILTER_CODES.has(code)
  );
}

function arrayify(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return [];
  }

  return Array.isArray(value)
    ? value
    : [value];
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2f;/gi, "/")
    .replace(/&#47;/g, "/");
}

function decodeURIComponentSafe(
  value
) {
  try {
    return decodeURIComponent(
      String(value || "")
    );
  } catch {
    return String(value || "");
  }
}

async function mapWithConcurrency(
  items,
  limit,
  mapper
) {
  const source = Array.from(
    items || []
  );

  const results =
    new Array(source.length);

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= source.length) {
        return;
      }

      results[index] =
        await mapper(
          source[index],
          index
        );
    }
  }

  const workers = Array.from(
    {
      length: Math.min(
        Math.max(1, limit),
        source.length || 1
      )
    },
    () => worker()
  );

  await Promise.all(workers);

  return results;
}

function chunkArray(
  items,
  size
) {
  const chunks = [];

  for (
    let index = 0;
    index < items.length;
    index += size
  ) {
    chunks.push(
      items.slice(
        index,
        index + size
      )
    );
  }

  return chunks;
}

async function mannGraphql(
  query,
  variables,
  cacheSeconds = 300
) {
  const url = new URL(MANN_ENDPOINT);
  url.searchParams.set("query", compactGraphql(query));
  url.searchParams.set(
    "variables",
    JSON.stringify(variables)
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        store: MANN_STORE,
        Referer: MANN_REFERER,
        "User-Agent":
          "Mozilla/5.0 (compatible; Boxes-MANN-Service/1.0)"
      },
      signal: controller.signal,
      next: {
        revalidate: cacheSeconds
      }
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "La consulta a MANN excedió el tiempo máximo"
      );
      timeoutError.statusCode = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();

  if (!response.ok) {
    const error = new Error(
      `MANN respondió HTTP ${response.status}: ${text.slice(
        0,
        500
      )}`
    );
    error.statusCode = 502;
    throw error;
  }

  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error(
      "MANN no devolvió un JSON válido"
    );
    error.statusCode = 502;
    throw error;
  }

  if (
    Array.isArray(payload.errors) &&
    payload.errors.length
  ) {
    const message = payload.errors
      .map((item) => item?.message)
      .filter(Boolean)
      .join(" | ");

    const error = new Error(
      message || "MANN devolvió un error GraphQL"
    );
    error.statusCode = 502;
    throw error;
  }

  if (!payload.data) {
    const error = new Error(
      "La respuesta de MANN no contiene data"
    );
    error.statusCode = 502;
    throw error;
  }

  return payload.data;
}

function normalizeVersion(item) {
  const from = normalizeDate(
    item?.vehicleManufacturedFrom
  );
  const to = normalizeDate(
    item?.vehicleManufacturedTo
  );

  const version = {
    vehicleTypeId: cleanString(item?.modelTypeId),
    modelId: cleanString(item?.modelSeriesId),
    model: cleanString(item?.modelSeriesName),
    vehicleName: cleanString(item?.vehicleName),
    modelCode: cleanString(item?.modelCode),
    engineCode: cleanString(item?.engineCode),
    fuelType: cleanString(item?.fuelType),
    ccm: numberOrNull(item?.ccm),
    kw: numberOrNull(item?.kw),
    bhp: numberOrNull(item?.bhp),
    serialNumberRange: cleanString(
      item?.serialNumberRange
    ),
    from,
    to
  };

  version.label = buildVersionLabel(version);

  return version;
}

function normalizeFilter(item) {
  const product = item?.product || {};

  const mannCode = firstNonEmpty([
    product.name,
    item?.productIdentifier,
    product.sku
  ]);

  const dates = extractDates(item?.linkages);
  const technicalData = extractLinkageText(
    item?.linkages
  );
  const attributes = extractAttributes(
    product.attributes
  );
  const references = extractReferences(
    product.references
  );

  return {
    type: cleanString(item?.product_type),
    mannCode,
    normalizedCode: normalizeFilterCode(
      mannCode
    ),
    sku: cleanString(product.sku),
    name: cleanString(product.name),
    productIdentifier: cleanString(
      item?.productIdentifier
    ),
    from: dates.from,
    to: dates.to,
    technicalData,
    attributes,
    references,
    productUrl: buildProductUrl(product.urlKey)
  };
}

function buildProductIndex(
  products,
  equivalenceMap
) {
  const index = new Map();

  products.forEach((product, position) => {
    const candidates = collectProductCodes(
      product,
      equivalenceMap
    );

    candidates.forEach(({ value, source }) => {
      const normalized = normalizeFilterCode(value);

      if (!normalized) return;

      if (!index.has(normalized)) {
        index.set(normalized, []);
      }

      index.get(normalized).push({
        product,
        source,
        position
      });
    });
  });

  return index;
}

function collectProductCodes(
  product,
  equivalenceMap
) {
  const values = [];

  const add = (value, source) => {
    if (Array.isArray(value)) {
      value.forEach((item) => add(item, source));
      return;
    }

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      values.push({
        value: String(value),
        source
      });
    }
  };

  add(product.codigoMann, "codigoMann");
  add(product.mannCode, "mannCode");
  add(product.referenciaMann, "referenciaMann");
  add(product.referencia, "referencia");
  add(product.equivalencias, "equivalencias");
  add(product.referencias, "referencias");
  add(product.codigoFabricante, "codigoFabricante");
  add(product.skuMann, "skuMann");

  const internalCode = firstNonEmpty([
    product.codigo,
    product.code,
    product.id
  ]);

  if (
    internalCode &&
    equivalenceMap[internalCode]
  ) {
    add(
      equivalenceMap[internalCode],
      "mapaEquivalencias"
    );
  }

  const mannCodesFromDescription =
    extractLikelyMannCodes(
      product.descripcion ||
        product.description ||
        product.nombre ||
        ""
    );

  add(
    mannCodesFromDescription,
    "descripcion"
  );

  return values;
}

function resolveFilter(filter, index) {
  const candidates = uniqueStrings([
    filter.mannCode,
    filter.sku,
    filter.productIdentifier,
    filter.name
  ]);

  for (const candidate of candidates) {
    const normalized =
      normalizeFilterCode(candidate);

    if (!normalized) continue;

    const entries = index.get(normalized) || [];
    const uniqueProducts = uniqueBy(
      entries,
      (entry) =>
        String(
          firstNonEmpty([
            entry.product.codigo,
            entry.product.code,
            entry.product.id,
            entry.position
          ])
        )
    );

    if (uniqueProducts.length === 1) {
      return {
        status: "matched",
        product: uniqueProducts[0].product,
        source: uniqueProducts[0].source,
        normalizedCode: normalized
      };
    }

    if (uniqueProducts.length > 1) {
      return {
        status: "ambiguous",
        products: uniqueProducts.map(
          (entry) => entry.product
        ),
        normalizedCode: normalized
      };
    }
  }

  return {
    status: "unmatched"
  };
}

function toBudgetProduct(product, filter) {
  return {
    ...product,
    codigo: firstNonEmpty([
      product.codigo,
      product.code,
      product.id
    ]),
    descripcion: firstNonEmpty([
      product.descripcion,
      product.description,
      product.nombre,
      filter.name,
      filter.mannCode
    ]),
    precio: numberOrZero(
      firstNonEmpty([
        product.precio,
        product.price,
        product.precioFinal
      ])
    ),
    cantidad: positiveInteger(
      product.cantidad,
      1
    ),
    tipoFiltro: filter.type,
    codigoMann: filter.mannCode,
    vehicleCompatibility: {
      from: filter.from,
      to: filter.to
    }
  };
}

function extractLikelyMannCodes(text) {
  const value = String(text || "").toUpperCase();

  const matches = value.match(
    /\b(?:HU|WK|PU|CUK|CU|FP|C|W|H)\s*[A-Z0-9]{1,6}(?:[\s/-]*[A-Z0-9]{1,6}){0,3}\b/g
  );

  return matches || [];
}

function normalizeFilterCode(value = "") {
  return String(value)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bMANN[\s-]*FILTER\b/g, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function extractDates(linkages) {
  const from = [];
  const to = [];

  for (const linkage of asArray(linkages)) {
    const interval = linkage?.date_interval || {};

    if (interval.linkage_fits_from) {
      from.push(
        normalizeDate(interval.linkage_fits_from)
      );
    }

    if (interval.linkage_fits_to) {
      to.push(
        normalizeDate(interval.linkage_fits_to)
      );
    }
  }

  return {
    from: uniqueStrings(from).join(", "),
    to: uniqueStrings(to).join(", ")
  };
}

function extractLinkageText(linkages) {
  const rows = [];

  for (const linkage of asArray(linkages)) {
    for (const item of asArray(linkage?.text)) {
      const label = firstNonEmpty([
        item?.module_name,
        item?.id,
        "Dato"
      ]);

      const value = cleanString(
        item?.module_value
      );

      const unit = cleanString(
        item?.module_unit
      );

      if (value) {
        rows.push({
          id: cleanString(item?.id),
          label,
          value,
          unit,
          text: `${label}: ${value}${
            unit ? ` ${unit}` : ""
          }`
        });
      }
    }
  }

  return uniqueBy(rows, (item) => item.text);
}

function extractAttributes(attributes) {
  return uniqueBy(
    asArray(attributes)
      .map((item) => ({
        key: cleanString(item?.key),
        value: firstNonEmpty([
          item?.value,
          item?.adminValue
        ])
      }))
      .filter((item) => item.key && item.value),
    (item) => `${item.key}|${item.value}`
  );
}

function extractReferences(references) {
  const rows = [];

  for (const reference of asArray(references)) {
    const type = firstNonEmpty([
      reference?.referenceTypeName,
      reference?.referenceTypeDescription,
      reference?.referenceTypeId
    ]);

    for (const product of asArray(
      reference?.referenceProducts
    )) {
      const code = firstNonEmpty([
        product?.salesDesignation,
        product?.urlKey
      ]);

      if (code) {
        rows.push({
          type,
          code,
          normalizedCode:
            normalizeFilterCode(code)
        });
      }
    }
  }

  return uniqueBy(
    rows,
    (item) => `${item.type}|${item.normalizedCode}`
  );
}

function buildModelLabel(item) {
  const name = cleanString(
    item?.suggestion_label
  );
  const date = cleanString(
    item?.model_series_date
  );

  return [name, date]
    .filter(Boolean)
    .join(" | ");
}

function buildVersionLabel(version) {
  const parts = [];

  if (version.vehicleName) {
    parts.push(version.vehicleName);
  }

  if (version.modelCode) {
    parts.push(version.modelCode);
  }

  const specs = [];

  if (version.ccm) {
    specs.push(`${version.ccm} cc`);
  }

  if (version.bhp) {
    specs.push(`${version.bhp} CV`);
  } else if (version.kw) {
    specs.push(`${version.kw} kW`);
  }

  if (version.engineCode) {
    specs.push(version.engineCode);
  }

  if (specs.length) {
    parts.push(specs.join(" · "));
  }

  const years = formatDateRange(
    version.from,
    version.to
  );

  if (years) {
    parts.push(years);
  }

  return parts.filter(Boolean).join(" | ");
}

function formatDateRange(from, to) {
  const fromText = formatMonthYear(from);

  const openEnded =
    !to ||
    String(to).startsWith("9999") ||
    String(to).startsWith("2099");

  if (fromText && openEnded) {
    return `desde ${fromText}`;
  }

  const toText = formatMonthYear(to);

  if (fromText && toText) {
    return `${fromText} a ${toText}`;
  }

  return fromText || toText || "";
}

function formatMonthYear(value) {
  const match = String(value || "").match(
    /^(\d{4})-(\d{2})/
  );

  if (!match) return "";

  return `${match[2]}/${match[1]}`;
}

function normalizeDate(value) {
  const text = cleanString(value);

  if (!text) return "";

  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})/
  );

  return match
    ? `${match[1]}-${match[2]}-${match[3]}`
    : text;
}

function buildProductUrl(urlKey) {
  const key = cleanString(urlKey);

  if (!key) return "";

  if (/^https?:\/\//i.test(key)) {
    return key;
  }

  return `https://www.mann-filter.com/ar-es/catalogo/${key.replace(
    /^\/+/,
    ""
  )}`;
}

function getAction(req) {
  const body = parseBody(req);

  return cleanString(
    getParam(req, "action") ||
      body.action ||
      "health"
  ).toLowerCase();
}

function getParam(req, key) {
  const queryValue = req?.query?.[key];

  if (Array.isArray(queryValue)) {
    return queryValue[0];
  }

  if (
    queryValue !== undefined &&
    queryValue !== null
  ) {
    return queryValue;
  }

  const body = parseBody(req);

  return body?.[key];
}


function getRepeatedQueryParam(
  req,
  key
) {
  const value = req?.query?.[key];

  if (Array.isArray(value)) {
    return value;
  }

  if (
    value !== undefined &&
    value !== null &&
    String(value).trim()
  ) {
    return [value];
  }

  return [];
}

function requireParam(req, key) {
  const value = cleanString(getParam(req, key));

  if (!value) {
    const error = new Error(
      `Falta el parámetro ${key}`
    );
    error.statusCode = 400;
    error.publicMessage = error.message;
    throw error;
  }

  return value;
}

function parseBody(req) {
  if (!req?.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function normalizeFilterType(value) {
  const filter = cleanString(
    value || "ALL_FILTER"
  ).toUpperCase();

  return FILTER_TYPES.has(filter)
    ? filter
    : "ALL_FILTER";
}

function applyCors(req, res) {
  const requestOrigin = cleanString(
    req?.headers?.origin
  );

  let allowedOrigin = "*";

  if (!ALLOWED_ORIGINS.includes("*")) {
    allowedOrigin = ALLOWED_ORIGINS.includes(
      requestOrigin
    )
      ? requestOrigin
      : ALLOWED_ORIGINS[0] || "";
  }

  if (allowedOrigin) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      allowedOrigin
    );
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Max-Age",
    "86400"
  );

  res.setHeader(
    "Vary",
    "Origin"
  );

  res.setHeader(
    "Cache-Control",
    "s-maxage=300, stale-while-revalidate=86400"
  );
}

function compactGraphql(query) {
  return String(query)
    .replace(/#[^\n\r]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanString(value) {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      return String(value).trim();
    }
  }

  return "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [
    ...new Set(
      values
        .map(cleanString)
        .filter(Boolean)
    )
  ];
}

function uniqueBy(items, keyGetter) {
  const map = new Map();

  for (const item of items) {
    const key = keyGetter(item);

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value, 10);

  return Number.isInteger(number) && number > 0
    ? number
    : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function numberOrNull(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function numberOrZero(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

function compareVersions(a, b) {
  const dateCompare = String(a.from).localeCompare(
    String(b.from)
  );

  if (dateCompare !== 0) {
    return dateCompare;
  }

  return String(a.label).localeCompare(
    String(b.label),
    "es"
  );
}

