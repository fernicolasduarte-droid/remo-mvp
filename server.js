
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = __dirname;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(publicPath));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Servidor de Remo funcionando correctamente" });
});

function isValidCoordinate(value) {
  return value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value));
}

function validateLatitude(lat) {
  const number = Number(lat);
  return number >= -90 && number <= 90;
}

function validateLongitude(lng) {
  const number = Number(lng);
  return number >= -180 && number <= 180;
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function roundToNearest(value, step = 50) {
  return Math.round(value / step) * step;
}

function calculateHaversineKm(originLat, originLng, destinationLat, destinationLng) {
  const earthRadiusKm = 6371;
  const deltaLat = toRadians(destinationLat - originLat);
  const deltaLng = toRadians(destinationLng - originLng);
  const lat1 = toRadians(originLat);
  const lat2 = toRadians(destinationLat);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

function getBuenosAiresTime(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  const weekday = parts.find((part) => part.type === "weekday")?.value || "";
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  return {
    hour,
    minute,
    weekday,
    isWeekend,
    isPeakHour: (hour >= 7 && hour < 10) || (hour >= 17 && hour < 21),
    isNight: hour >= 22 || hour < 6,
    isWeekendNight: isWeekend && (hour >= 20 || hour < 6)
  };
}

function isNearPoint(lat, lng, targetLat, targetLng, radiusKm) {
  return calculateHaversineKm(lat, lng, targetLat, targetLng) <= radiusKm;
}

function buildAirportContext(originLat, originLng, destinationLat, destinationLng) {
  const airports = [
    { name: "Aeroparque Jorge Newbery", lat: -34.5580307, lng: -58.4170085, radiusKm: 2.5 },
    { name: "Ezeiza", lat: -34.822222, lng: -58.535833, radiusKm: 4 }
  ];

  const matchedAirport = airports.find((airport) => {
    return isNearPoint(originLat, originLng, airport.lat, airport.lng, airport.radiusKm) ||
      isNearPoint(destinationLat, destinationLng, airport.lat, airport.lng, airport.radiusKm);
  });

  return { isAirportRoute: Boolean(matchedAirport), airportName: matchedAirport?.name || null };
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "application/json", "User-Agent": "Remo MVP local development" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getWeatherContext(lat, lng) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    `&current=temperature_2m,precipitation,rain,weather_code,wind_speed_10m` +
    `&timezone=America%2FArgentina%2FBuenos_Aires`;
  try {
    const data = await fetchJsonWithTimeout(url, 5000);
    const current = data.current || {};
    const precipitation = Number(current.precipitation || 0);
    const rain = Number(current.rain || 0);
    const weatherCode = Number(current.weather_code || 0);
    const windSpeed = Number(current.wind_speed_10m || 0);
    const isRaining = precipitation > 0 || rain > 0;
    const isStorm = [95, 96, 99].includes(weatherCode);
    return {
      available: true,
      temperature: Number(current.temperature_2m || 0),
      precipitation,
      rain,
      weatherCode,
      windSpeed,
      isRaining,
      isStorm,
      isBadWeather: isRaining || isStorm || windSpeed >= 35
    };
  } catch (error) {
    console.warn("No se pudo consultar clima:", error.message);
    return {
      available: false,
      temperature: null,
      precipitation: 0,
      rain: 0,
      weatherCode: null,
      windSpeed: null,
      isRaining: false,
      isStorm: false,
      isBadWeather: false
    };
  }
}

function estimateDurationFallback(distanceKm, timeContext) {
  let averageSpeedKmh = 18;
  if (timeContext.isPeakHour) averageSpeedKmh = 13;
  if (timeContext.isNight) averageSpeedKmh = 24;
  return Math.max(4, (distanceKm / averageSpeedKmh) * 60);
}

async function getDrivingRouteInfo(originLat, originLng, destinationLat, destinationLng, timeContext) {
  const coordinates = `${originLng},${originLat};${destinationLng},${destinationLat}`;
  const osrmServers = [
    { name: "OSRM demo router.project-osrm.org", url: `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&alternatives=false&steps=false` },
    { name: "OSRM FOSSGIS routing.openstreetmap.de", url: `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordinates}?overview=full&geometries=geojson&alternatives=false&steps=false` }
  ];

  for (const server of osrmServers) {
    try {
      const data = await fetchJsonWithTimeout(server.url, 8000);
      if (!data || data.code !== "Ok" || !data.routes || !data.routes[0]) {
        throw new Error(`Respuesta invalida: ${data?.code || "sin codigo"}`);
      }
      const route = data.routes[0];
      const distanceKm = route.distance / 1000;
      const durationMin = Number.isFinite(route.duration)
        ? Math.max(4, route.duration / 60)
        : estimateDurationFallback(distanceKm, timeContext);
      return {
        distanceKm,
        durationMin,
        source: server.name,
        fallback: false,
        geometry: route.geometry || null
      };
    } catch (error) {
      console.warn(`Fallo ${server.name}:`, error.message);
    }
  }

  const straightLineKm = calculateHaversineKm(originLat, originLng, destinationLat, destinationLng);
  const distanceKm = straightLineKm * 1.35;
  return {
    distanceKm,
    durationMin: estimateDurationFallback(distanceKm, timeContext),
    source: "Fallback local Haversine x 1.35",
    fallback: true,
    geometry: {
      type: "LineString",
      coordinates: [
        [originLng, originLat],
        [destinationLng, destinationLat]
      ]
    }
  };
}

function buildPricingContext(timeContext, weatherContext, airportContext) {
  const factors = [];
  let multiplier = 1;

  if (timeContext.isPeakHour) { multiplier *= 1.10; factors.push("hora pico"); }
  if (timeContext.isNight) { multiplier *= 1.08; factors.push("horario nocturno"); }
  if (timeContext.isWeekendNight) { multiplier *= 1.08; factors.push("fin de semana/noche"); }
  if (weatherContext.isRaining) { multiplier *= 1.12; factors.push("lluvia"); }
  if (weatherContext.isStorm) { multiplier *= 1.18; factors.push("tormenta"); }
  if (airportContext.isAirportRoute) {
    multiplier *= 1.05;
    factors.push(`zona aeropuerto${airportContext.airportName ? ` (${airportContext.airportName})` : ""}`);
  }

  const cappedMultiplier = Math.min(multiplier, 1.65);
  let demandLevel = "normal";
  if (cappedMultiplier >= 1.30) demandLevel = "alta";
  else if (cappedMultiplier >= 1.10) demandLevel = "media";

  return {
    multiplier: Number(cappedMultiplier.toFixed(2)),
    demandLevel,
    factors,
    time: timeContext,
    weather: weatherContext,
    airport: airportContext
  };
}

const PUBLIC_TRANSPORT_FARES = {
  busMin: 820.6,
  busMax: 1059.28,
  subwayRegistered: 1621,
  subwayUnregistered: 2541.1,
  trainMin: 520,
  trainMax: 950
};

const PRODUCT_CONFIG = {
  auto: [
    { app: "Uber", product: "UberX", icon: "🚗", action: "uber_v2", integration: "Ruta validada en Android", base: 1450, perKm: 520, perMin: 95, min: 3200, rangeNormal: 1200, rangeMedium: 1500, rangeHigh: 1800, appMultiplier: 1.48 },
    { app: "Uber", product: "Comfort", icon: "🚘", action: "uber_v2", integration: "Ruta validada en Android", base: 2100, perKm: 600, perMin: 115, min: 4200, rangeNormal: 1300, rangeMedium: 1600, rangeHigh: 1900, appMultiplier: 1.42 },
    { app: "Cabify", product: "Cabify", icon: "🚙", action: "cabify_app", integration: "Ingreso manual requerido", base: 1700, perKm: 540, perMin: 100, min: 3500, rangeNormal: 1500, rangeMedium: 1900, rangeHigh: 2300, appMultiplier: 1.30 },
    { app: "DiDi", product: "DiDi Auto", icon: "🚗", action: "didi_or_maps", integration: "Ingreso manual requerido", base: 1300, perKm: 480, perMin: 88, min: 3000, rangeNormal: 1500, rangeMedium: 1900, rangeHigh: 2300, appMultiplier: 1.25 }
  ],
  moto: [
    { app: "Uber", product: "Moto", icon: "🏍️", action: "uber_v2", integration: "Ruta validada via Uber", base: 900, perKm: 430, perMin: 70, min: 2400, rangeNormal: 700, rangeMedium: 900, rangeHigh: 1100, appMultiplier: 1.0 },
    { app: "DiDi", product: "DiDi Moto", icon: "🏍️", action: "didi_or_maps", integration: "Ingreso manual requerido", base: 850, perKm: 390, perMin: 62, min: 2200, rangeNormal: 800, rangeMedium: 1000, rangeHigh: 1200, appMultiplier: 0.98 }
  ],
  envios: [
    { app: "Uber", product: "Flash", icon: "📦", action: "uber_v2", integration: "Abre Uber; confirmar producto", base: 1150, perKm: 430, perMin: 68, min: 2600, rangeNormal: 1100, rangeMedium: 1400, rangeHigh: 1700, appMultiplier: 1.35 },
    { app: "Cabify", product: "Envios", icon: "⚡", action: "cabify_app", integration: "Ingreso manual requerido", base: 1350, perKm: 460, perMin: 72, min: 2800, rangeNormal: 1100, rangeMedium: 1400, rangeHigh: 1700, appMultiplier: 1.25 },
    { app: "DiDi", product: "Entrega", icon: "📦", action: "didi_or_maps", integration: "Ingreso manual requerido", base: 1100, perKm: 410, perMin: 65, min: 2500, rangeNormal: 1100, rangeMedium: 1400, rangeHigh: 1700, appMultiplier: 1.20 }
  ]
};

function getRangeWidth(productConfig, demandLevel) {
  if (demandLevel === "alta") return productConfig.rangeHigh;
  if (demandLevel === "media") return productConfig.rangeMedium;
  return productConfig.rangeNormal;
}

function estimateProductPrice(productConfig, routeInfo, pricingContext) {
  const rawPrice = productConfig.base + routeInfo.distanceKm * productConfig.perKm + routeInfo.durationMin * productConfig.perMin;
  const contextualPrice = Math.max(productConfig.min, rawPrice * pricingContext.multiplier * productConfig.appMultiplier);
  const center = roundToNearest(contextualPrice, 50);
  const rangeWidth = getRangeWidth(productConfig, pricingContext.demandLevel);
  const min = Math.max(productConfig.min, center - rangeWidth / 2);
  const max = Math.max(min + 450, center + rangeWidth / 2);
  return {
    price: center,
    price_min: roundToNearest(min, 50),
    price_max: roundToNearest(max, 50),
    range_width: roundToNearest(max - min, 50)
  };
}

function createOption(productConfig, routeInfo, pricingContext) {
  const estimate = estimateProductPrice(productConfig, routeInfo, pricingContext);
  return {
    app: productConfig.app,
    name: productConfig.app,
    product: productConfig.product,
    icon: productConfig.icon,
    action: productConfig.action,
    integration: productConfig.integration,
    price: estimate.price,
    price_min: estimate.price_min,
    price_max: estimate.price_max,
    range_width: estimate.range_width,
    currency: "ARS",
    distance_km: Number(routeInfo.distanceKm.toFixed(2)),
    duration_min: Number(routeInfo.durationMin.toFixed(0)),
    confidence: productConfig.app === "Uber"
      ? (pricingContext.demandLevel === "normal" ? "media-alta" : "media")
      : "media-baja",
    description: productConfig.app === "Uber"
      ? `Rango estimado por Remo para ${productConfig.product}. Ruta automatica disponible.`
      : `Rango estimado por Remo para ${productConfig.product}. Requiere pegar destino manualmente.`
  };
}


function isPointInsideCaba(lat, lng) {
  // Bounding box conservadora de CABA. No es geocerca perfecta, pero evita mostrar subte en rutas claramente fuera de CABA.
  return lat >= -34.705 &&
    lat <= -34.525 &&
    lng >= -58.535 &&
    lng <= -58.335;
}

function isRouteInsideCaba(origin, destination) {
  if (!origin || !destination) {
    return false;
  }

  return isPointInsideCaba(origin.lat, origin.lng) &&
    isPointInsideCaba(destination.lat, destination.lng);
}

function createPublicTransportItems(routeInfo, origin, destination) {
  const distanceKm = routeInfo.distanceKm;
  const durationMin = routeInfo.durationMin;
  const busSegments = distanceKm > 10 ? 2 : 1;
  const needsCombination = distanceKm > 8;
  const routeInsideCaba = isRouteInsideCaba(origin, destination);
  const canSubwayHelp = routeInsideCaba && distanceKm >= 4 && distanceKm <= 16;
  const canTrainHelp = distanceKm >= 9;
  const busMin = PUBLIC_TRANSPORT_FARES.busMin * busSegments;
  const busMax = PUBLIC_TRANSPORT_FARES.busMax * busSegments;

  const items = [
    {
      app: "SUBE", name: "SUBE", product: busSegments === 1 ? "Colectivo" : "Colectivo x2", icon: "🚌",
      action: "google_maps_transit", integration: "Abrir ruta en Google Maps",
      price: roundToNearest((busMin + busMax) / 2, 10), price_min: roundToNearest(busMin, 10), price_max: roundToNearest(busMax, 10),
      range_width: roundToNearest(busMax - busMin, 10), currency: "ARS", distance_km: Number(distanceKm.toFixed(2)),
      duration_min: Math.round(durationMin * 1.7), confidence: "baja",
      description: routeInsideCaba
        ? "Estimacion SUBE en CABA. Las lineas exactas se confirman en Maps."
        : "Estimacion SUBE. Fuera de CABA no mostramos subte; las lineas exactas se confirman en Maps."
    }
  ];

  if (canSubwayHelp) {
    const min = needsCombination ? PUBLIC_TRANSPORT_FARES.subwayRegistered + PUBLIC_TRANSPORT_FARES.busMin : PUBLIC_TRANSPORT_FARES.subwayRegistered;
    const max = needsCombination ? PUBLIC_TRANSPORT_FARES.subwayUnregistered + PUBLIC_TRANSPORT_FARES.busMax : PUBLIC_TRANSPORT_FARES.subwayUnregistered;
    items.push({
      app: "SUBE", name: "SUBE", product: needsCombination ? "Colectivo + Subte" : "Subte", icon: "🚇",
      action: "google_maps_transit", integration: "Abrir ruta en Google Maps",
      price: roundToNearest((min + max) / 2, 10), price_min: roundToNearest(min, 10), price_max: roundToNearest(max, 10),
      range_width: roundToNearest(max - min, 10), currency: "ARS", distance_km: Number(distanceKm.toFixed(2)),
      duration_min: Math.round(durationMin * 1.55), confidence: "baja",
      description: "Estimacion con subte. Confirma combinacion, horarios y caminata en Maps."
    });
  }

  if (canTrainHelp) {
    const min = PUBLIC_TRANSPORT_FARES.trainMin + PUBLIC_TRANSPORT_FARES.busMin;
    const max = PUBLIC_TRANSPORT_FARES.trainMax + PUBLIC_TRANSPORT_FARES.busMax;
    items.push({
      app: "SUBE", name: "SUBE", product: "Tren + Colectivo", icon: "🚆",
      action: "google_maps_transit", integration: "Abrir ruta en Google Maps",
      price: roundToNearest((min + max) / 2, 10), price_min: roundToNearest(min, 10), price_max: roundToNearest(max, 10),
      range_width: roundToNearest(max - min, 10), currency: "ARS", distance_km: Number(distanceKm.toFixed(2)),
      duration_min: Math.round(durationMin * 1.65), confidence: "baja",
      description: "Estimacion con tren. La linea y frecuencia se validan en Maps."
    });
  }

  return items.sort((a, b) => a.price_min - b.price_min);
}

function buildSections(routeInfo, pricingContext, origin, destination) {
  return [
    { id: "auto", title: "Auto", icon: "🚗", subtitle: "Precios estimados por app", items: PRODUCT_CONFIG.auto.map((product) => createOption(product, routeInfo, pricingContext)).sort((a, b) => a.price_min - b.price_min) },
    { id: "moto", title: "Moto", icon: "🏍️", subtitle: "Opciones rapidas y economicas", items: PRODUCT_CONFIG.moto.map((product) => createOption(product, routeInfo, pricingContext)).sort((a, b) => a.price_min - b.price_min) },
    { id: "envios", title: "Envios", icon: "📦", subtitle: "Paquetes, courier y mensajeria", items: PRODUCT_CONFIG.envios.map((product) => createOption(product, routeInfo, pricingContext)).sort((a, b) => a.price_min - b.price_min) },
    { id: "public_transport", title: "Bus", icon: "🚌", subtitle: isRouteInsideCaba(origin, destination) ? "Colectivo, subte, tren y combinaciones" : "Colectivo, tren y combinaciones", items: createPublicTransportItems(routeInfo, origin, destination) }
  ];
}


function buildPromotions(pricingContext) {
  const airport = pricingContext.airport || {};
  const isEzeizaRoute = airport.isAirportRoute && String(airport.airportName || "").toLowerCase().includes("ezeiza");

  return [
    {
      app: "Cabify",
      provider: "BBVA Mastercard Black",
      title: "Cabify x BBVA Mastercard Black",
      badge: isEzeizaRoute ? "Aplica a esta ruta" : "Ezeiza 2026",
      description: "100% de descuento hacia o desde Aeropuerto de Ezeiza con código MCBBVA2026. Tope $50.000 por vigencia, 1 viaje por vigencia, según BBVA.",
      code: "MCBBVA2026",
      priority: isEzeizaRoute ? 1 : 2,
      route_match: isEzeizaRoute,
      type: "bank"
    },
    {
      app: "Cabify",
      provider: "Remo",
      title: "Promos Cabify en app",
      badge: "Verificar",
      description: "No aplicamos promos vencidas. Revisá en Cabify si tu cuenta tiene cupones, banco o descuento activo antes de confirmar.",
      code: null,
      priority: 3,
      route_match: false,
      type: "app"
    },

    {
      app: "Uber",
      provider: "Uber",
      title: "Promos personales de Uber",
      badge: "Variable",
      description: "Uber puede aplicar cupones o descuentos personales dentro de la app. Remo no puede verlos sin cuenta sincronizada.",
      code: null,
      priority: 4,
      route_match: false,
      type: "app"
    },
    {
      app: "DiDi",
      provider: "DiDi",
      title: "Cupones DiDi",
      badge: "Variable",
      description: "DiDi puede aplicar cupones, referidos o descuentos personales dentro de la app.",
      code: null,
      priority: 5,
      route_match: false,
      type: "app"
    }
  ].sort(function(a, b) {
    if (a.route_match !== b.route_match) {
      return a.route_match ? -1 : 1;
    }

    return a.priority - b.priority;
  });
}


async function getRouteAndContext(req, res) {
  const { start_lat, start_lng, end_lat, end_lng } = req.query;
  if (!isValidCoordinate(start_lat) || !isValidCoordinate(start_lng) || !isValidCoordinate(end_lat) || !isValidCoordinate(end_lng)) {
    res.status(400).json({ status: "error", message: "Faltan parametros o hay coordenadas invalidas.", required_params: ["start_lat", "start_lng", "end_lat", "end_lng"] });
    return null;
  }
  if (!validateLatitude(start_lat) || !validateLatitude(end_lat) || !validateLongitude(start_lng) || !validateLongitude(end_lng)) {
    res.status(400).json({ status: "error", message: "Las coordenadas estan fuera de rango." });
    return null;
  }

  const originLat = Number(start_lat);
  const originLng = Number(start_lng);
  const destinationLat = Number(end_lat);
  const destinationLng = Number(end_lng);
  const timeContext = getBuenosAiresTime();
  const [routeInfo, weatherContext] = await Promise.all([
    getDrivingRouteInfo(originLat, originLng, destinationLat, destinationLng, timeContext),
    getWeatherContext(originLat, originLng)
  ]);
  const airportContext = buildAirportContext(originLat, originLng, destinationLat, destinationLng);
  const pricingContext = buildPricingContext(timeContext, weatherContext, airportContext);
  return { origin: { lat: originLat, lng: originLng }, destination: { lat: destinationLat, lng: destinationLng }, routeInfo, pricingContext };
}

app.get("/api/options", async (req, res) => {
  try {
    const result = await getRouteAndContext(req, res);
    if (!result) return;
    const sections = buildSections(result.routeInfo, result.pricingContext, result.origin, result.destination);
    res.json({
      route: {
        distance_km: Number(result.routeInfo.distanceKm.toFixed(2)),
        duration_min: Number(result.routeInfo.durationMin.toFixed(0)),
        source: result.routeInfo.source,
        fallback: result.routeInfo.fallback,
        geometry: result.routeInfo.geometry || null
      },
      context: result.pricingContext,
      promotions: buildPromotions(result.pricingContext),
      sections
    });
  } catch (error) {
    console.error("Error en /api/options:", error);
    res.status(500).json({ status: "error", message: "No se pudieron calcular las opciones del viaje.", detail: error.message });
  }
});

app.get("/api/prices", async (req, res) => {
  try {
    const result = await getRouteAndContext(req, res);
    if (!result) return;
    const sections = buildSections(result.routeInfo, result.pricingContext, result.origin, result.destination);
    res.json(sections.find((section) => section.id === "auto")?.items || []);
  } catch (error) {
    console.error("Error en /api/prices:", error);
    res.status(500).json({ status: "error", message: "No se pudo calcular el precio del viaje.", detail: error.message });
  }
});

function getLocalNetworkUrls(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];
  Object.values(interfaces).forEach((networkInterface) => {
    networkInterface?.forEach((details) => {
      if (details.family === "IPv4" && !details.internal) urls.push(`http://${details.address}:${port}`);
    });
  });
  return urls;
}

app.use((req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor de Remo corriendo en http://localhost:${PORT}`);
  const localUrls = getLocalNetworkUrls(PORT);
  if (localUrls.length > 0) {
    console.log("Disponible desde el celular en:");
    localUrls.forEach((url) => console.log(`- ${url}`));
  } else {
    console.log("No pude detectar IP de red local. Usa ipconfig para verla.");
  }
});
