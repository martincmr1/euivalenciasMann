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

/*
 * Respaldo directo de Adobe Scene7 / Dynamic Media.
 * Ejemplo válido:
 * https://s7g10.scene7.com/is/image/mannhummel/W_940.1-1
 */
const MANN_SCENE7_BASE =
  process.env.MANN_SCENE7_BASE ||
  "https://s7g10.scene7.com/is/image/mannhummel";

const MANN_SCENE7_QUALITY = clamp(
  positiveInteger(
    process.env.MANN_SCENE7_QUALITY,
    82
  ),
  1,
  100
);

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
          normalizeFilterCode(mannCode) !==
          "NOFILTER"
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

  const images = await getMannImages(
    mannCodes,
    width
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
        .filter(isValidCatalogFilter)
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
  width = 600
) {
  const uniqueCodes = uniqueStrings(
    mannCodes
      .map(cleanString)
      .filter(Boolean)
      .filter(
        (mannCode) =>
          normalizeFilterCode(mannCode) !==
          "NOFILTER"
      )
  );

  if (!uniqueCodes.length) {
    return {};
  }

  /*
   * Primera estrategia:
   * consulta oficial a /bin/assets.json.
   *
   * Segunda estrategia:
   * si el asset no aparece allí, se intenta localizarlo
   * directamente en Adobe Scene7 utilizando el patrón
   * real de MANN, por ejemplo:
   *
   * W 940/1  -> W_940.1-1
   * W 940/81 -> W_940.81-1
   */
  const batches = chunkArray(uniqueCodes, 20);
  const allHits = [];

  for (const batch of batches) {
    const hits = await fetchMannAssetBatch(batch);
    allHits.push(...hits);
  }

  const entries = await Promise.all(
    uniqueCodes.map(async (mannCode) => {
      const hit = findBestAssetHit(
        allHits,
        mannCode
      );

      if (hit) {
        const normalizedHit = normalizeAssetHit(
          hit,
          mannCode,
          width
        );

        if (normalizedHit.imageUrl) {
          return [
            mannCode,
            {
              ...normalizedHit,
              source: "assets-api"
            }
          ];
        }
      }

      const scene7Image =
        await resolveScene7Fallback(
          mannCode,
          width
        );

      if (scene7Image) {
        console.log(
          "[MANN-IMG-SERVER] Imagen recuperada mediante Scene7",
          {
            mannCode,
            scene7File:
              scene7Image.scene7File,
            imageUrl:
              scene7Image.imageUrl
          }
        );

        return [mannCode, scene7Image];
      }

      console.warn(
        "[MANN-IMG-SERVER] No se encontró imagen",
        {
          mannCode,
          candidates:
            buildScene7AssetCandidates(
              mannCode
            )
        }
      );

      return [
        mannCode,
        {
          mannCode,
          imageUrl: "",
          found: false,
          source: "missing",
          scene7Candidates:
            buildScene7AssetCandidates(
              mannCode
            )
        }
      ];
    })
  );

  return Object.fromEntries(entries);
}

async function fetchMannAssetBatch(
  mannCodes
) {
  const url = new URL(MANN_ASSETS_ENDPOINT);

  url.searchParams.set("metaData", "true");
  url.searchParams.set(
    "brand",
    "MANN-FILTER"
  );
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
      Math.max(
        25,
        mannCodes.length * 3
      )
    )
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
        Accept: "application/json",
        Referer: MANN_REFERER,
        "User-Agent":
          "Mozilla/5.0 (compatible; Boxes-MANN-Service/1.1)"
      },
      signal: controller.signal,
      next: {
        revalidate: 86400
      }
    });
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

  return asArray(payload?.hits);
}

function findBestAssetHit(
  hits,
  mannCode
) {
  const target =
    normalizeAssetReference(mannCode);

  const matching = asArray(hits).filter(
    (hit) => {
      const references = asArray(
        hit?.metaData?.productReferences
      );

      return references.some(
        (reference) =>
          normalizeAssetReference(
            reference
          ) === target
      );
    }
  );

  return (
    matching.find(
      (hit) =>
        isTrueValue(
          hit?.metaData?.mainImage
        ) &&
        cleanString(
          hit?.metaData?.productView
        ).toLowerCase() === "front"
    ) ||
    matching.find((hit) =>
      isTrueValue(
        hit?.metaData?.mainImage
      )
    ) ||
    matching[0] ||
    null
  );
}

function normalizeAssetHit(
  hit,
  mannCode,
  width
) {
  const uriTemplate = cleanString(
    hit?.uriTemplate
  );

  const scene7File = cleanString(
    hit?.metaData?.["dam:scene7File"]
  );

  const scene7Domain = cleanString(
    hit?.metaData?.["dam:scene7Domain"]
  );

  let imageUrl = "";

  if (uriTemplate) {
    imageUrl = uriTemplate.replace(
      "{width}",
      String(width)
    );
  } else if (
    scene7File &&
    scene7Domain
  ) {
    imageUrl = buildScene7ImageUrl(
      scene7File,
      width,
      normalizeScene7BaseUrl(
        scene7Domain
      )
    );
  } else {
    const directLink = cleanString(
      hit?.link
    );

    if (
      directLink &&
      /(?:\/is\/image\/|\.(?:png|jpe?g|webp)(?:[?#]|$))/i.test(
        directLink
      )
    ) {
      try {
        imageUrl = new URL(
          directLink,
          MANN_REFERER
        ).toString();
      } catch {
        imageUrl = directLink;
      }
    }
  }

  return {
    mannCode,
    found: Boolean(imageUrl),
    imageUrl,
    uriTemplate,
    link: cleanString(hit?.link),
    mimeType: cleanString(
      hit?.mimeType
    ),
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
    scene7File,
    productReferences: asArray(
      hit?.metaData?.productReferences
    )
  };
}

async function resolveScene7Fallback(
  mannCode,
  width
) {
  const candidates =
    buildScene7AssetCandidates(mannCode);

  if (!candidates.length) {
    return null;
  }

  /*
   * Se prueban los candidatos en paralelo para evitar
   * multiplicar el tiempo de respuesta del endpoint.
   * Promise.allSettled impide que un fallo individual
   * de Scene7 rompa toda la consulta.
   */
  const checks = await Promise.allSettled(
    candidates.map(async (scene7File) => ({
      scene7File,
      exists: await scene7AssetExists(
        scene7File
      )
    }))
  );

  const firstExisting = checks
    .map((result) =>
      result.status === "fulfilled"
        ? result.value
        : null
    )
    .find((result) => result?.exists);

  if (!firstExisting) {
    return null;
  }

  return {
    mannCode,
    found: true,
    source: "scene7-fallback",
    imageUrl: buildScene7ImageUrl(
      firstExisting.scene7File,
      width
    ),
    uriTemplate: "",
    link: "",
    mimeType: "image/jpeg",
    width: null,
    height: null,
    title: `Filtro MANN ${mannCode}`,
    productView: "Front",
    mainImage: true,
    scene7File: firstExisting.scene7File,
    productReferences: [
      buildMannProductReference(mannCode)
    ],
    scene7Candidates: candidates
  };
}

async function scene7AssetExists(
  scene7File
) {
  const scene7Base =
    normalizeScene7BaseUrl(
      MANN_SCENE7_BASE
    );

  const normalizedFile =
    normalizeScene7FileForBase(
      scene7File,
      scene7Base
    );

  const encodedFile = normalizedFile
    .split("/")
    .map((part) =>
      encodeURIComponent(part)
    )
    .join("/");

  const existsUrl = new URL(
    `${scene7Base.replace(/\/+$/, "")}/${encodedFile}`
  );

  existsUrl.searchParams.set(
    "req",
    "exists"
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.min(REQUEST_TIMEOUT_MS, 7000)
  );

  let response;

  try {
    response = await fetch(
      existsUrl.toString(),
      {
        method: "GET",
        headers: {
          Accept: "text/plain,*/*",
          Referer: MANN_REFERER,
          "User-Agent":
            "Mozilla/5.0 (compatible; Boxes-MANN-Service/1.2)"
        },
        signal: controller.signal,
        next: {
          revalidate: 86400
        }
      }
    );
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.warn(
        "[MANN-IMG-SERVER] Error verificando Scene7",
        {
          scene7File,
          message: error?.message
        }
      );
    }

    return false;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return false;
  }

  const text = await response.text();

  return parseScene7ExistsResponse(text);
}

function parseScene7ExistsResponse(
  value
) {
  const text = cleanString(value);

  if (!text) return false;

  if (/^1$/.test(text)) return true;
  if (/^true$/i.test(text)) return true;

  if (
    /(?:^|\b)exists\s*[:=]\s*(?:1|true)\b/i.test(
      text
    )
  ) {
    return true;
  }

  if (
    /["']exists["']\s*:\s*(?:1|true)/i.test(
      text
    )
  ) {
    return true;
  }

  return false;
}

function normalizeScene7BaseUrl(
  value
) {
  const base = cleanString(value).replace(
    /\/+$/,
    ""
  );

  if (!base) {
    return MANN_SCENE7_BASE.replace(
      /\/+$/,
      ""
    );
  }

  if (/\/is\/image\/[^/]+$/i.test(base)) {
    return base;
  }

  if (/\/is\/image$/i.test(base)) {
    return `${base}/mannhummel`;
  }

  return `${base}/is/image/mannhummel`;
}

function normalizeScene7FileForBase(
  scene7File,
  baseUrl
) {
  let file = cleanString(scene7File)
    .replace(/^\/+/, "");

  if (!file) return "";

  try {
    const base = new URL(baseUrl);
    const company = base.pathname
      .split("/")
      .filter(Boolean)
      .at(-1);

    if (
      company &&
      file.toLowerCase().startsWith(
        `${company.toLowerCase()}/`
      )
    ) {
      file = file.slice(company.length + 1);
    }
  } catch {
    // Si la base no es una URL válida, se conserva el archivo.
  }

  return file;
}

function buildScene7ImageUrl(
  scene7File,
  width,
  baseUrl = MANN_SCENE7_BASE
) {
  const normalizedBase =
    normalizeScene7BaseUrl(baseUrl);

  const normalizedFile =
    normalizeScene7FileForBase(
      scene7File,
      normalizedBase
    );

  const encodedFile = normalizedFile
    .split("/")
    .map((part) =>
      encodeURIComponent(part)
    )
    .join("/");

  const url = new URL(
    `${normalizedBase.replace(/\/+$/, "")}/${encodedFile}`
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
    String(MANN_SCENE7_QUALITY)
  );
  url.searchParams.set("dpr", "off");

  return url.toString();
}

function buildScene7AssetCandidates(
  mannCode
) {
  const code = cleanString(mannCode)
    .toUpperCase()
    .replace(/_MANN-FILTER$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!code) return [];

  const match = code.match(
    /^([A-Z]+)\s*(.+)$/
  );

  if (!match) return [];

  const prefix = match[1];
  const remainder = match[2]
    .replace(/^[-_.\s]+/, "")
    .trim();

  if (!remainder) return [];

  const variants = uniqueStrings([
    remainder
      .replace(/\//g, ".")
      .replace(/[\s_-]+/g, "."),

    remainder
      .replace(/\//g, ".")
      .replace(/[\s-]+/g, "_"),

    remainder
      .replace(/\s+/g, "")
      .replace(/\//g, "."),

    remainder.replace(
      /[^A-Z0-9]+/g,
      "."
    )
  ])
    .map((value) =>
      value
        .replace(/\.{2,}/g, ".")
        .replace(/_{2,}/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "")
    )
    .filter(Boolean);

  const candidates = [];

  for (const variant of variants) {
    const lowerSuffix = variant.replace(
      /[A-Z]/g,
      (letter) => letter.toLowerCase()
    );

    candidates.push(
      `${prefix}_${variant}-1`
    );

    if (lowerSuffix !== variant) {
      candidates.push(
        `${prefix}_${lowerSuffix}-1`
      );
    }
  }

  return uniqueStrings(candidates).slice(
    0,
    8
  );
}

function buildMannProductReference(
  mannCode
) {
  const code = cleanString(mannCode)
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
    .replace(/_MANN-FILTER$/i, "")
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

function isTrueValue(value) {
  return (
    value === true ||
    String(value).toLowerCase() === "true"
  );
}

function chunkArray(items, size) {
  const chunks = [];

  for (
    let index = 0;
    index < items.length;
    index += size
  ) {
    chunks.push(
      items.slice(index, index + size)
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

function isValidCatalogFilter(item) {
  if (!item) return false;

  const normalizedCode =
    normalizeFilterCode(
      item.normalizedCode ||
        item.mannCode ||
        item.name ||
        item.productIdentifier ||
        item.sku
    );

  return Boolean(
    normalizedCode &&
      normalizedCode !== "NOFILTER"
  );
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

