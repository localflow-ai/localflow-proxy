// Usage: node scripts/build-api-config.js

const fs = require('fs');
const path = require('path');

/*
 * API configuration file generator. This script generates a JSON file that defines how the proxy should interact with various third-party APIs.
 * Each entry defines how to interact with a specific API, including:
 * {
 *   name: "API Name",
 *   topic: "General Topic",
 *   id: "unique-api-id",
 *   baseUrl: "https://api.example.com" or ["https://api1.example.com", "https://api2.example.com"],
 *   force: true, // If true, forces the use of this API even if not selected by the user
 *   rewriteRules: [ // Optional URL rewrite rules for this API
 *     ['replace', 'search-pattern', 'replacement-pattern']
 *   ]
 *   waitMs: 100, // Optional delay between requests to this API
 *   apiKey: 'your-api-key', // API key value to inject
 *   apiKeyRoutePlaceholder: '{apiKey}', // Placeholder in baseUrl for API key injection
 *   apiKeyHeader: 'X-API-Key', // Optional header name for API key (if not using URL query param)
 *   apiKeyQueryParam: 'apiKey', // Optional query parameter name for API key (for all request types)
 *   apiKeyQueryParamGetOnly: 'apiKey', // Optional query parameter name for API key in GET requests
 *   apiKeyBodyParam: 'apiKey', // Optional body parameter name for API key in POST/PUT requests
 *   requiredReferer: 'https://example.com', // Optional referer header value required by the API
 *   requiredOrigin: 'https://example.com', // Optional origin header value required by the API
 *   requiredUserAgent: 'Custom User Agent', // Optional user agent string required by the API
 * }
 */

const configData = [
    {
        name: "OverPass",
        topic: "Spatial analysis",
        id: "overpass",
        baseUrl: 'https://overpass-api.de/api/interpreter',
        apiKeyRoutePlaceholder: '{apiKey}',
        apiKey: 'fa30b3dbaceb457ba9748173ff24da48',
        rewriteRules: [
            [
                'replace', 'https://overpass-api.de/api/interpreter', 'https://overpass.geofabrik.de/{apiKey}/api/interpreter'
            ]
        ],
        force: true,
        prepaid: true,
        description: `OpenStreetMap's OverPass API allows to access most data that can be put on a map worldwide. For example: roads, forests, buildings, rivers, lakes, infrastructures, ...`,
        prompt: `Use OpenStreetMap's OverPass API (*HIGHLY PREFERED*) and Turf.js (available in \`turf\`). Example: find closest rivers and calculate distance. When using Overpass, remember the BBOX order is (south, west, north, east).`
    },

    // ========================================================================================================    
    {
        name: "OSRM",
        topic: "Routing",
        id: "osrm",
        baseUrl: ['https://routing.openstreetmap.de', 'https://router.project-osrm.org'],
        apiKeyRoutePlaceholder: '{apiKey}',
        apiKey: '308fc7330c8c4e54a89a995eb2bb4fee',
        rewriteRules: [
            [
                'replace', 'https://routing.openstreetmap.de/routed-car/route/', 'https://routing.geofabrik.de/{apiKey}/route/',
                'replace', 'https://router.project-osrm.org/routed-car/route/', 'https://routing.geofabrik.de/{apiKey}/route/',
                'replace', 'https://routing.openstreetmap.de/', 'https://routing.geofabrik.de/{apiKey}/',
                'replace', 'https://router.project-osrm.org', 'https://routing.geofabrik.de/{apiKey}/'
            ]
        ],
        force: true,
        prepaid: true,
        prompt: `Use OSRM to calculate distance and time by transportation. The base url is \`https://routing.openstreetmap.de\`.`,
        description: `OSRM is the Open Source engine for routing. It can be used to calculate itineraries or find the distance and time between two points by any transportation means.`
    },

    // ========================================================================================================    
    {
        name: "IGN Geoplateforme",
        topic: "Advanced French GIS",
        id: "ign",
        waitMs: "100",
        baseUrl: [
            "https://data.geopf.fr/geocodage/search",
            "https://data.geopf.fr/geocodage/reverse",
            "https://data.geopf.fr/altimetrie/v1/elevation",
            "https://data.geopf.fr/navigation/itineraire",
            "https://data.geopf.fr/wfs/ows",
            "https://wfs.geoportail-urbanisme.gouv.fr/wfs",
            "https://api-adresse.data.gouv.fr/search",
            "https://api-adresse.data.gouv.fr/reverse"
        ],
        rewriteRules: [
            [
                'replace', "https://api-adresse.data.gouv.fr/search", 'https://data.geopf.fr/geocodage/search',
                'replace', "https://api-adresse.data.gouv.fr/reverse", 'https://data.geopf.fr/geocodage/reverse',
                'replace', "https://wfs.geoportail-urbanisme.gouv.fr/wfs", 'https://data.geopf.fr/wfs/ows'
            ]
        ],
        description: `This is the primary hub for French public geographic data. It provides access to:
        - **Geocoding & Search**: Convert text addresses or POIs into coordinates.
        - **Reverse Geocoding**: Find addresses or cadastral parcels near a GPS point.
        - **WFS Vector Layers**: Access official databases for Cadastre (parcels), Urban Planning (PLU), Hydrography, and Forestry.
        - **Altimetry**: Get precise ground elevation (Z) for coordinates.
        - **Routing**: Calculate itineraries for cars, pedestrians, or emergency vehicles.`,
        prompt: `When using the IGN Geoplateforme, choose the sub-route based on the specific intent:

| Path | Endpoint | Parameters | Schema |
| :--- | :--- | :--- | :--- |
| /geocodage/search | Geocoding (Text to GPS) | q, index (address, poi, parcel), limit, postcode, type (housenumber, street, locality, municipality) | GeoJSONFC |
| /geocodage/reverse | Reverse Geocoding | lat, lon, index (address, poi, parcel), limit, search_radius | GeoJSONFC |
| /wfs/ows | Vector Data (WFS) | SERVICE=WFS, VERSION=2.0.0, REQUEST=GetFeature, TYPENAMES, BBOX, OUTPUTFORMAT=application/json | GeoJSONFC |
| /altimetrie/v1/elevation | Elevation (Z) | lon, lat, resource (ign_rge_alti_wld), delimiter, indent | ElevationRes |
| /navigation/itineraire | Routing (Itinerary) | start, end, resource (bdtopo-osrm, bdtopo-valhalla), profile (car, pedestrian), optimization (fastest, shortest), getSteps, getGeometry | RoutingRes |

Available WFS layers to be used in the TYPENAMES param include (*IMPORTANT*: do not try other types unless given to you by the user):
* \`CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle\` : parcelles. Example for properties in returned features: {"gid":77759101,"numero":"0067","feuille":1,"section":"AW","code_dep":"14","nom_com":"Lisieux","code_com":"366","com_abs":"000","code_arr":"000","idu":"14366000AW0067","contenance":112,"code_insee":"14366"},
* \`wfs_du:zone_urba\` : Plan Local d'Urbanisme (PLU). Example for properties in returned features: {"gid":3106227,"gpu_doc_id":"426a9c9d28a6850c0f9dacea82896315","gpu_status":"production","gpu_timestamp":"2025-10-03T06:26:39.185Z","partition":"DU_200069532_C","libelle":"UE","libelong":"pavillonnaire diffus","typezone":"U","destdomi":null,"nomfic":"200069532_reglement_20250327_C.pdf"},
* \`BDTOPO_V3:foret_publique\`, 
* \`BDCARTO_V5:construction_surfacique\`, 
* \`BDCARTO_V5:occupation_du_sol\`, 
* \`BDCARTO_V5:rond_point\`, 
* \`BDCARTO_V5:transport_par_cable\`, 
* \`BDCARTO_V5:zone_d_activite_ou_d_interet\`, 
* \`BDCARTO_V5:zone_d_habitation\`, 
* \`LANDCOVER.FORESTINVENTORY.V1:resu_bdv1_shape\`, 
* \`PROTECTEDAREAS.APB:apb\` : arrêtés de protection de biotope,
* \`patrinat_ramsar:pnm\` : zone humide d'importance internationale (Ramsar),
* \`BDTOPO_V3:terrain_de_sport\`, 
* \`BDTOPO_V3:zone_de_vegetation\`
* \`MESURES_COMPENSATOIRES:emprises_commune\` (mesures compensatoires des atteintes a la biodiversite)
* \`MESURES_COMPENSATOIRES:emprises_lineaires\` (mesures compensatoires des atteintes a la biodiversite)
* \`MESURES_COMPENSATOIRES:emprises_polygones\` (mesures compensatoires des atteintes a la biodiversite)
* \`MESURES_COMPENSATOIRES:emprises_ponctuelles\` (mesures compensatoires des atteintes a la biodiversite)
* \`wfs_sup:assiette_sup_s\` servitudes d'utilité publiques (surfaces),
* \`wfs_sup:assiette_sup_p\` servitudes d'utilité publiques (ponctuelles),
* \`wfs_sup:assiette_sup_l\` servitudes d'utilité publiques (linéaires),
* \`patrinat_pnr:pnr\` parc naturel régional (PNR)\`,
* \`essai_gpkg_raster_v2_gpkg_03-02-2025_wfs:composantes_de_la_trame_verte_nsm\` (trame verte et bleue, ZNIEFF 1 et ZNIEFF 2)

IMPORTANT: 
ALWAYS use the following template that works for all layers when calling the WFS endpoint, keep the explicit EPSG:4326 coordinate system, and replace the TYPENAMES and BBOX parameters:
\`https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=patrinat_pnr:pnr&BBOX=45.1,-1.28,49.18,1.28,urn:ogc:def:crs:EPSG::4326&SRSNAME=urn:ogc:def:crs:EPSG::4326&OUTPUTFORMAT=application/json\`

- Coordinate Order: Geocoding and WFS GeoJSON return [Longitude, Latitude]. 
- WFS BBOX is [LatMin, LonMin, LatMax, LonMax]
- Parameter naming: Use \`lon\` for geocoding/elevation and \`lon,lat\` strings for routing.

### Response Schemas
\`\`\`typescript
// Standard GeoJSON FeatureCollection used by Geocoding and WFS
interface GeoJSONFC {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point" | "Polygon" | "MultiPolygon"; coordinates: any };
    properties: Record<string, any>; // label, city, postcode, idu (for parcels)
  }>;
}

// Elevation Response
interface ElevationRes {
  elevations: Array<{ lon: number; lat: number; z: number; acc: number }>;
}

// Routing Response
interface RoutingRes {
  geometry: { type: "LineString"; coordinates: [number, number][] };
  distance: number; // in meters
  duration: number; // in seconds
  portion: Array<{ distance: number; duration: number; steps: any[] }>;
}
\`\`\`

### Examples

For WFS, call https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_sup:assiette_sup_s&BBOX=49.10,0.18,49.18,0.28&&OUTPUTFORMAT=application/json and replace the type and bounding box parameters.


\`\`\`
`
    },
    /*    {
            name: "Geoplateforme IGN",
            topic: "Advanced",
            id: "ign",
            waitMs: "100",
            baseUrl: ['https://data.geopf.fr/wfs/ows', 'https://wfs.geoportail-urbanisme.gouv.fr/wfs'],
            description: `The French IGN geo platform, which allows you to access any data in the IGN GIS. This is Open Data. Note that \`https://wfs.geoportail-urbanisme.gouv.fr\` is deprecated but still active for backward compatibility.
    Here are some examples of data you can get from the IGN geo platform:
    * Cadastral parcels (cadastre) with the \`CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle\` type,
    * Urban planning data (PLU) with the \`wfs_du:zone_urba\` type,
    * Public utility servitudes with the \`wfs_sup:assiette_sup_s\` type,
    * Forests with the \`BDTOPO_V3:foret_publique\` type,
    * Land use with the \`BDCARTO_V5:occupation_du_sol\` type,
    * Protected biotopes with the \`PROTECTEDAREAS.APB:apb\` type,
    * Ramsar wetlands with the \`patrinat_ramsar:pnm\` type, 
    * Sports fields with the \`BDTOPO_V3:terrain_de_sport\` type, 
    * Vegetation zones with the \`BDTOPO_V3:zone_de_vegetation\` type,
    * And many more (see https://data.geopf.fr/explore/dataset/ign-geoportail/ for the full list).        
            `,
            prompt: `For France and very specific government data, use the IGN API https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_sup:assiette_sup_s&BBOX=49.10,0.18,49.18,0.28&&OUTPUTFORMAT=application/json and replace the type and bounding box parameters. 
    
    When you call the service, be extra careful about the coordinates order of the BBOX parameter and of the values returned to make sure they are in the order expected by JS and turf.js.
    
    Available geojson data are (*IMPORTANT*: do not try other types unless given to you by the user): 
    * \`CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle\` : parcelles. Example for properties in returned features: {"gid":77759101,"numero":"0067","feuille":1,"section":"AW","code_dep":"14","nom_com":"Lisieux","code_com":"366","com_abs":"000","code_arr":"000","idu":"14366000AW0067","contenance":112,"code_insee":"14366"},
    * \`wfs_du:zone_urba\` : Plan Local d'Urbanisme (PLU). Example for properties in returned features: {"gid":3106227,"gpu_doc_id":"426a9c9d28a6850c0f9dacea82896315","gpu_status":"production","gpu_timestamp":"2025-10-03T06:26:39.185Z","partition":"DU_200069532_C","libelle":"UE","libelong":"pavillonnaire diffus","typezone":"U","destdomi":null,"nomfic":"200069532_reglement_20250327_C.pdf"},
    * \`wfs_sup:assiette_sup_s\` servitudes d'utilité publiques,
    * \`BDTOPO_V3:foret_publique\`, 
    * \`BDCARTO_V5:construction_surfacique\`, 
    * \`BDCARTO_V5:occupation_du_sol\`, 
    * \`BDCARTO_V5:rond_point\`, 
    * \`BDCARTO_V5:transport_par_cable\`, 
    * \`BDCARTO_V5:zone_d_activite_ou_d_interet\`, 
    * \`BDCARTO_V5:zone_d_habitation\`, 
    * \`LANDCOVER.FORESTINVENTORY.V1:resu_bdv1_shape\`, 
    * \`PROTECTEDAREAS.APB:apb\` : arrêtés de protection de biotope,
    * \`patrinat_ramsar:pnm\` : zone humide d'importance internationale (Ramsar),
    * \`BDTOPO_V3:terrain_de_sport\`, 
    * \`BDTOPO_V3:zone_de_vegetation\``
        },*/

    // ========================================================================================================    
    {
        topic: "Routing",
        name: "IGN Isochrone",
        id: "ign-isochrone",
        waitMs: "100",
        baseUrl: ["https://data.geopf.fr/navigation/isochrone"],
        description: "Calculates isochrones (areas reachable within a given time) or isodistances (areas reachable within a given distance) across France using OSRM or Valhalla engines.",
        prompt: `To calculate an accessibility zone (isochrone/isodistance) in France, use the endpoint \`https://data.geopf.fr/navigation/isochrone\`.

### REQUIRED PARAMETERS
- **point**: Starting coordinates formatted as \`longitude,latitude\` (e.g., \`2.3373,48.8493\`).
- **resource**: Always use \`bdtopo-valhalla\`.
- **costType**: \`time\` (for isochrone) or \`distance\` (for isodistance).
- **costValue**: Numeric value for the cost (e.g., 600 for 10 minutes if timeUnit is seconds).

### RECOMMENDED PARAMETERS
- **profile**: \`car\`, \`pedestrian\`.
- **direction**: \`departure\` (from point) or \`arrival\` (to point).
- **timeUnit**: \`minute\`, \`second\`, or \`hour\`.
- **distanceUnit**: \`meter\` or \`kilometer\`.

### RESPONSE STRUCTURE
### RESPONSE STRUCTURE
The API returns a JSON object containing a GeoJSON 'Polygon' geometry. Use this TypeScript interface:

\`\`\`typescript
interface IGNIsochroneResponse {
    point: string;              // "lon,lat"
    resource: string;           // e.g., "bdtopo-valhalla"
    resourceVersion: string;    // e.g., "2026-03-13"
    costType: "time" | "distance";
    costValue: number;
    timeUnit?: string;
    distanceUnit?: string;
    profile: string;
    direction: string;
    geometry: {
        type: "Polygon";
        coordinates: Array<Array<[number, number]>>; // Array of [Lon, Lat] pairs
    };
    constraints: any[];
}
\`\`\`

*IMPORTANT*: When processing the \`geometry.coordinates\`, remember that the first array level represents the polygon, and the second level is the list of points. Each point is \`[longitude, latitude]\`.`
    },

    // ========================================================================================================    
    {
        name: "APICarto",
        topic: "Advanced",
        id: "apicarto",
        waitMs: "100",
        baseUrl: 'https://apicarto.ign.fr/api',
        description: `
The Carto API is an IGN OpenData API.

### Available modules:

| Module | Description | Link |
| :--- | :--- | :--- |
| **Cadastre** | Access to cadastral data (municipality, division, plot/parcel, etc.). | [API Documentation](./cadastre) |
| **Administrative Boundaries** | Retrieval of administrative data (municipality, department, region). | [API Documentation](./limites-administratives) |
| **Postcodes** | Retrieval of municipalities based on a postcode. | [API Documentation](./codes-postaux) |
| **Urban Planning (GpU)** | Access to Urban Planning Geoportail data (PLU, POS, CC, SUP). | [API Documentation](./gpu) |
| **RPG** | Access to Graphical Parcel Register data (crops/agriculture). | [API Documentation](./rpg) |
| **WFS-Geoportail** | Generic access to any Geoportail WFS feed. | [API Documentation](./wfs-geoportail) |
| **Nature** | Access to feeds based on MNHN (National Museum of Natural History) data. | [API Documentation](./nature) |
| **AOC** | Access to Controlled Appellation of Origin (AOC) data. | [API Documentation](./aoc) |
        `,
        prompt: `For France and specific government data, use the APICarto API (https://apicarto.ign.fr/api) with the appropriate module (cadastre, limites-administratives, codes-postaux, gpu, rpg, wfs-geoportail, nature, aoc). Each module API is available at https://apicarto.ign.fr/api/{module} and documented at https://apicarto.ign.fr/api/doc/{module}.`
    },

    // ========================================================================================================    
    {
        topic: "Elevation",
        name: "Open Meteo Elevation",
        id: "elevation",
        baseUrl: "https://api.open-meteo.com/v1/elevation",
        apiKeyRoutePlaceholder: '{apiKey}',
        apiKey: 'wVQs28qlP99RxDRm',
        rewriteRules: [
            ['replace', "https://api.open-meteo.com/v1/elevation?", 'https://customer-api.open-meteo.com/v1/elevation?apikey={apiKey}&']

        ],
        force: true,
        prepaid: true,
        description: "Open Meteo Elevation is a service to get the elevation worldwide.",
        prompt: `Use Open Meteo Elevation API (available at \`https://api.open-meteo.com/v1/elevation\`) when the analysis requires elevation on many objets. Example: show topology around a point.`
    },
    /*    {
            topic: "Reverse Geocoding",
            name: "French Reverse Geocoding",
            id: "french-reverse-geocoding",
            waitMs: "100",
            baseUrl: ["https://data.geopf.fr/geocodage/reverse", "https://api-adresse.data.gouv.fr/reverse"],
            rewriteRules: [
                ['replace', "https://api-adresse.data.gouv.fr/reverse", 'https://data.geopf.fr/geocodage/reverse']
            ],
            description: "Get an address from coordinates in France.",
            prompt: `To reverse geocode an address in France, use the \`https://data.geopf.fr/geocodage/reverse\` endpoint.`
        },
        {
            topic: "Geocoding",
            name: "French Address Search",
            id: "french-address-search",
            waitMs: "100",
            baseUrl: ["https://data.geopf.fr/geocodage/search", "https://api-adresse.data.gouv.fr/search"],
            rewriteRules: [
                ['replace', "https://api-adresse.data.gouv.fr/search", 'https://data.geopf.fr/geocodage/search']
            ],
            description: "Convert a text address into GPS coordinates and structured data in France.",
            prompt: `To geocode an address in France, use the \`https://data.geopf.fr/geocodage/search\` endpoint with a \`q\` parameter. 
    
    The API returns a GeoJSON FeatureCollection. Use this TypeScript type to parse the response:
    \`\`\`typescript
    type GeocodingResponse = {
        type: "FeatureCollection";
        features: Array<{
            type: "Feature";
            geometry: { type: "Point"; coordinates: [number, number] }; // [Longitude, Latitude]
            properties: {
                label: string;      // Full address string
                score: number;      // 0 to 1 accuracy
                name: string;       // Street/Place name
                postcode: string;
                city: string;
                context: string;    // Dept info
                type: "housenumber" | "street" | "locality" | "municipality";
            };
        }>;
    };
    \`\`\`
    
    *IMPORTANT*: The coordinates are returned as \`[longitude, latitude]\`. If you are passing these to Turf.js or the Overpass BBOX (which uses south, west, north, east), ensure you map the indices correctly (e.g., \`lat = coords[1]\`, \`lon = coords[0]\`).`
        },*/

    // ========================================================================================================    
    {
        topic: "Environmental Risks",
        name: "Géorisques V1",
        id: "georisques-v1",
        waitMs: "200",
        baseUrl: ["https://www.georisques.gouv.fr/api/v1"],
        rewriteRules: [],
        description: `Legacy French Géorisques V1 API. It provides established endpoints for risk assessment, including the unique consolidated "risques/details" summary.`,
        prompt: `To use the Géorisques V1 API, append the specific module path to the base URL (\`https://www.georisques.gouv.fr/api/v1\`). 

**Pagination:** Response structures vary; data is often in a \`data\` property or at root. Params: page (starts at 1), page_size (max 100).
**Rules:** Use snake_case for params (e.g., code_insee, page_size). Spatial queries use a \`latlon\` parameter which is a string of "longitude, latitude" (IT IS REVERSED, yes). Max rayon = 10000 (in meters).

| Path | Endpoint | Parameters |
| :--- | :--- | :--- | :--- |
| /gaspar/risques | Full Risk Summary | code_insee, latlon, rayon, page, page_size |
| /gaspar/catnat | Natural Disasters | code_insee, latlon, rayon, page, page_size |
| /installations_classees | Industrial Sites | departement, region, page, page_size |
| /installations_nucleaires | Nuclear Sites | code_insee, latitude, longitude |
| /ssp | Polluted Soils (SSP) | code_insee, latlon, rayon, page, page_size |
| /old | Obligations Légales de Débroussaillement | code_insee, latlon |
| /mvt | Landslides | code_insee, latlon, rayon, page, region, departement, type ("Effondrement / Affaissement", "Coulée", "Glissement", "Erosion de berges", "Chute de blocs / Eboulement"), page, page_size |
| /cavites | Underground Cavities | code_insee, latlon, rayon, region, departement, identifiant, type (Cave, Naturelle, Indéterminé, Ouvrage civil, Puits, Divers, Galerie, Carrière, Indice, Ouvrage militaire, Réseau galeries, Souterrain), page, page_size |
| /gaspar/azi | Inundation - AZI Program | code_insee, latlon, rayon, page, page_size |
| /radon | Radon Risk | code_insee, page, page_size |
| /dicrim | Prevention Docs | code_insee, latlon, rayon, page, page_size |
`
    },

    // ========================================================================================================    
    {
        topic: "Environmental Risks",
        name: "Géorisques V2",
        id: "georisques-v2",
        apiKey: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJub20iOiJQQVdMQUsiLCJwcmVub20iOiJSZW5hdWQgUGllcnJlIEJydW5vIiwiZW1haWwiOiJyZW5hdWQucGF3bGFrQGdtYWlsLmNvbSIsImV4cCI6MTgwNDg5NjAwMCwiaWF0IjoxNzczMzkxODg2fQ._FyQ44l5DPzptN9fW9YJCpTu3uclT4ZF0mlUCqrMsws",
        apiKeyHeader: "Authorization",
        waitMs: "200",
        baseUrl: ["https://www.georisques.gouv.fr/api/v2"],
        rewriteRules: [],
        description: `Access to the comprehensive French Géorisques V2 database. This version offers granular access to specific risk themes:
        - **Inundation**: AZI, TRI, and PAPI programs.
        - **Ground & Soil**: Clay swelling (RGA), landslides (MVT), and cavities.
        - **Technological & Industrial**: Classified installations (ICPE), nuclear sites, and polluted soils (SSP/BASOL).
        - **Planning & Regulation**: Detailed PPR (Natural, Technological, Mining) and DICRIM documents.
        - **Natural Hazards**: Seismic zoning and Radon potential.`,
        prompt: `To use the Géorisques V2 API, append the specific module path to the base URL (\`https://www.georisques.gouv.fr/api/v2\`). 

**Pagination:** Data is in .content[]. Params: page (starts at 1), pageSize (max 100).
**Rules:** Use camelCase for params (e.g., codeInsee, pageSize). Max rayon = 10000.

| Path | Endpoint | Parameters | Schema |
| :--- | :--- | :--- | :--- |
| /gaspar/risques | Risk Dictionary | page, pageSize | RiskDict |
| /installations_classees | Industrial Sites (ICPE) | codeInsee, lat, lon, rayon, page, pageSize, raisonSociale, siret, etatActivite, codeNaf, statutSeveso, bovins, porcs, volailles, carriere, eolienne, industrie, prioriteNationale, ied | ICPE |
| /rga | Clay Swelling (RGA) | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | RGA |
| /zonage_sismique | Seismic Zoning | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | Seisme |
| /radon | Radon Gas Potential | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | Radon |
| /mvt | Landslides History | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | MVT |
| /cavites | Underground Cavities | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | Cavite |
| /ssp | Polluted Soils (SSP) | codeInsee, lat, lon, rayon, geometry, codesParcelle, page, pageSize | SSP |
| /gaspar/pprn | Natural Risk Plans | codeInsee, libPpr, etatProcedure, page, pageSize | PPR |
| /gaspar/pprt | Tech Risk Plans | codeInsee, libPpr, etatProcedure, page, pageSize | PPR |
| /gaspar/pprm | Mining Risk Plans | codeInsee, libPpr, etatProcedure, page, pageSize | PPR |
| /gaspar/azi | Flood Zone Atlas | codeInsee, page, pageSize | AZI |
| /gaspar/tri | Flood Risk Territory | codeInsee, page, pageSize | TRI |

### Response Schemas
\`\`\`typescript
interface Paginated<T> { totalElements: number; content: T[]; }
interface RiskDict { code_risque: string; libelle_risque: string; }
interface ICPE { codeAIOT: string; raisonSociale: string; etatActivite: string; latitude: number; longitude: number; statutSeveso: string; codeInsee: string; commune: string; siret: string; regime: string; }
interface RGA { codeInsee: string; commune: string; classe_exposition: "Fort"|"Moyen"|"Faible"|"Nul"; }
interface Seisme { codeInsee: string; zone: string; libelle: string; }
interface Radon { codeInsee: string; classe_potentiel: number; }
interface MVT { id_mvt: string; libelle_mvt: string; date_evenement: string; latitude: number; longitude: number; }
interface Cavite { id_cavite: string; libelle_cavite: string; type_cavite: string; latitude: number; longitude: number; }
interface SSP { id_ssp: string; nomEtablissement: string; typeFiche: "CASIAS"|"SIS"|"SUP"; codeInsee: string; latitude: number; longitude: number; }
interface PPR { idGaspar: string; libPpr: string; etatProcedure: string; zonageReglementaire: { listTypeReg: Array<{ code: string; libelle: string; nom: string }> }; }
\`\`\`
`
    },

    /*    {
            topic: "Environmental Risks",
            name: "Géorisques V1",
            id: "georisques-risk-details",
            waitMs: "200",
            baseUrl: ["https://www.georisques.gouv.fr/api/v1/risques/details"],
            rewriteRules: [],
            description: "Retrieve a summary of all natural and technological risks for a specific location in France.",
            prompt: `To get risk details for a location, use the \`https://www.georisques.gouv.fr/api/v1/risques/details\` endpoint. 
    
    REQUIRED PARAMS: You must provide \`lat\` and \`long\` (decimal degrees).
    
    RESPONSE STRUCTURE: 
    
    \`\`\`typescript
    interface GeorisquesRiskDetails {
      page: number;
      pageSize: number;
      totalCount: number;
      
      data: {
        // Natural risks (e.g., floods, earthquakes, landslides)
        risques_naturels: Array<{
          code_risque: string;
          libelle_risque: string;
          description?: string;
          // Many entries include the administrative procedure (PPRN)
          procedue_ppr?: {
            nom_procedure: string;
            etat_procedure: string;
            date_approbation?: string;
          };
        }>;
    
        // Technological risks (e.g., industrial sites, nuclear, dam failure)
        risques_technologiques: Array<{
          code_risque: string;
          libelle_risque: string;
          nom_etablissement?: string; // Often present for industrial risks
          distance_m?: number;
        }>;
    
        // Soil/Ground specific risks
        mouvements_de_terrain?: Array<{
          type_mouvement: string;
          intensite: string;
          date_evenement?: string;
        }>;
    
        // Retrait-Gonflement des Argiles (Clay swelling/shrinking)
        rga?: {
          classe_exposition: "Faible" | "Moyen" | "Fort";
          description: string;
        };
    
        // Radon gas exposure
        radon?: {
          classe_potentiel: number; // Usually 1, 2, or 3
          description: string;
        };
    
        // Seismic zone
        seisme?: {
          zone: string; // e.g., "1 - Très faible" to "5 - Forte"
          description: string;
        };
      };
    }
    \`\`\`
    `
        },*/

    // ========================================================================================================    
    {
        topic: "Urbanisme et Environnement",
        name: "Cerema Cartofriches (Preprod)",
        id: "cerema-cartofriches-preprod",
        waitMs: 500,
        baseUrl: "https://apidf-preprod.cerema.fr",
        description: "Inventaire national des friches (industrielles, commerciales, habitat) via le portail Datafoncier du Cerema.",
        prompt: `Use GET https://apidf-preprod.cerema.fr/cartofriches/friches/?code_insee={code_insee}&coddep={coddep}&in_bbox={min_lon},{min_lat},{max_lon},{max_lat}. 
Important: You must provide all geographical filters (code_insee, coddep, an in_bbox).
Other available query parameters are:
- ordering (string): Which field to use when ordering the results.
- page (integer): A page number within the paginated result set.
- page_size (integer): Number of results to return per page.
- surface_max (number): Surface maximale de l'unité foncière
- surface_min (number): Surface minimale de l'unité foncière
- urba_zone_type (string): Type de zone d'urbanisme

### Response example:
\`\`\`json
{
  "count": 13,
  "next": null,
  "previous": null,
  "results": [
    {
      "site_id": "14258_26849",
      "site_nom": "Ancien Leader Price",
      "site_type": "friche commerciale",
      "site_adresse": null,
      "site_statut": "friche avec projet",
      "comm_nom": "Falaise",
      "comm_insee": "14258",
      "dep": "14",
      "proprio_personne": "personne morale",
      "unite_fonciere_surface": 10592.338839733191,
      "unite_fonciere_refcad": "['14258000BN0415', '14258000BN0414']",
      "source_nom": "EPF Normandie",
      "nature": "observatoire local",
      "urba_zone_type": "U"
    },
    ...
  ]
}
\`\`\`
`
    },

    // ========================================================================================================    
    {
        topic: "Photovoltaic Data",
        name: "PVGIS (Photovoltaic Geographical Information System)",
        id: "pvgis",
        waitMs: "500",
        baseUrl: ["https://re.jrc.ec.europa.eu/api"],
        description: "PVGIS (Photovoltaic Geographical Information System), a service provided by the Joint Research Centre (JRC) of the European Commission.",
        prompt: `Use PVGIS to get photovoltaic data. Available endpoints are documented at https://re.jrc.ec.europa.eu/api/v5_2/
Here is the data structure returned by PVGIS for a typical request:
\`\`\`typescript
interface PVGISData {
  inputs: {
    location: {
      latitude: number;
      longitude: number;
      elevation: number;
    };
    meteo_data: {
      radiation_db: string;
      meteo_db: string;
      year_min: number;
      year_max: number;
      use_horizon: boolean;
      horizon_db: string;
    };
    mounting_system: {
      fixed: {
        slope: { value: number; optimal: boolean };
        azimuth: { value: number; optimal: boolean };
        type: string;
      };
    };
    pv_module: {
      technology: string;
      peak_power: number;
      system_loss: number;
    };
    economic_data: {
      system_cost: number | null;
      interest: number | null;
      lifetime: number | null;
    };
  };
  outputs: {
    monthly: {
      fixed: Array<{
        month: number;
        E_d: number;    // Average daily energy production (kWh/d)
        E_m: number;    // Average monthly energy production (kWh/mo)
        "H(i)_d": number; // Average daily global irradiation (kWh/m2/d)
        "H(i)_m": number; // Average monthly global irradiation (kWh/m2/mo)
        SD_m: number;   // Standard deviation of monthly production
      }>;
    };
    totals: {
      fixed: {
        E_d: number;
        E_m: number;
        E_y: number;    // Average annual energy production (kWh/y)
        "H(i)_d": number;
        "H(i)_m": number;
        "H(i)_y": number;
        SD_m: number;
        SD_y: number;
        l_aoi: number;   // Angle of incidence loss (%)
        l_spec: string | number; // Spectral loss (%) - Note: sometimes returned as string
        l_tg: number;    // Temp/Irradiance loss (%)
        l_total: number; // Total system loss (%)
      };
    };
  };
  meta: Record<string, any>; // Documentation metadata
}\`\`\`
        `
    },

    // ========================================================================================================    
    {
        topic: "Administrative Boundaries",
        name: "French Administrative Boundaries (geo.api.gouv.fr)",
        id: "geo-api-gouv-fr",
        waitMs: "100",
        baseUrl: "https://geo.api.gouv.fr/",
        description: "Get French administrative boundaries for communes, departments, regions, etc.",
        prompt: `To get French administrative boundaries, use the https://geo.api.gouv.fr/ endpoints.`
    },

    // ========================================================================================================    
    {
        topic: "Demographics & Local Stats",
        name: "INSEE Melodi",
        id: "insee-melodi",
        waitMs: "500",
        baseUrl: "https://api.insee.fr/melodi",
        apiKey: "Bearer 1845eea1-69f0-4d28-85ee-a169f03d28a0",
        apiKeyHeader: "Authorization",
        description: "Socio-economic data at the local level: population density, age brackets, housing types, business and employment stats by city or area.",
        prompt: `Use the INSEE Melodi API at \`https://api.insee.fr/melodi\` to retrieve demographic statistics for specific French territories.

### Examples:

- **Avialable datasets**: \`https://api.insee.fr/melodi/V2/catalog/all\`
- **Population data**: \`https://api.insee.fr/melodi/data/DS_POPULATIONS_REFERENCE?GEO=DEP-44\`
- **Business creations**: \`https://api.insee.fr/melodi/data/DS_SIDE_CREA_ENT_SERIES?TIME_PERIOD=2023\`

### Vibe coding process:
If your query does not work, provide the user with a list of available datasets and their codes from \`/melodi/V2/catalog/all\` and ask them to choose the correct one for their query.
`
    },

    // ========================================================================================================    
    {
        topic: "Macro-economic Indicators",
        name: "INSEE BDM (Economic Series)",
        id: "insee-bdm",
        waitMs: "500",
        baseUrl: "https://api.insee.fr/series/BDM",
        apiKey: "Bearer 1845eea1-69f0-4d28-85ee-a169f03d28a0",
        apiKeyHeader: "Authorization",
        description: "Time-series data for the French economy. Includes the Consumer Price Index (Inflation), GDP growth, and construction cost indices.",
        prompt: `Use \`https://api.insee.fr/series/BDM\` to query economic indices and time series data via the INSEE BDM endpoints.
        
### Example Queries:
**Series Catalog**: \`https://api.insee.fr/series/BDM/V1/dataflow/all\` (to find available series and their codes).
**Price Index (Inflation)**: \`https://api.insee.fr/series/BDM/V1/data/SERIES_BDM/001763119\`

### Result structure:
Do not pass any accept headers. The API always returns SDMX-ML formatted XML.

### Vibe coding process:
If your query does not work, provide the user with a list of available series and their codes from \`/series/BDM/V1/dataflow/all\` and ask them to choose the correct one for their query.
        `
    },

    // ========================================================================================================    
    {
        topic: "Non-Profit Data",
        name: "French National Association Register (RNA)",
        id: "api-rna",
        waitMs: "200",
        baseUrl: "https://entreprise.data.gouv.fr/api/rna/v1",
        description: "The primary source for French non-profit organizations (Associations). Use this for entities that do not appear in the Sirene register.",
        prompt: "To get data on a French association, query the RNA ID at https://entreprise.data.gouv.fr/api/rna/v1/id/{id}."
    },
    /*{
        topic: "Enterprise Data",
        name: "INSEE Sirene API",
        id: "insee-sirene",
        waitMs: "2000",
        baseUrl: "https://api.insee.fr/api-sirene/3.11",
        //apiKey: "1845eea1-69f0-4d28-85ee-a169f03d28a0",        
        //apiKeyHeader: "X-INSEE-Api-Key-ID",
        rewriteRules: [
            [ 'decrypt-header', 'X-INSEE-Api-Key-ID' ],
            [ 'inject-header', 'X-INSEE-Api-Key-ID', '1845eea1-69f0-4d28-85ee-a169f03d28a0']
        ],
        description: `
# INSEE Sirene API Summary

The Sirene API provides access to the French National Register of Businesses and their Establishments.

### 🛡️ Core Search Entities
* **Siren**: Information on the **Legal Unit** (the company as a legal entity).
* **Siret**: Information on the **Establishment** (a specific physical location or branch).

### 📊 Available Data Points
* **Identity**: Company name, Legal status (SAS, SARL, etc.), and Registration numbers.
* **Activity**: **NAF/APE Code** (Industry classification) and Creation/Closure dates.
* **Location**: Full postal address, department, and city codes.
* **Size**: Workforce bracket (number of employees) and Company category (SME, ETI, etc.).
* **History**: Tracking of changes in name, address, or legal status over time.

### 🔍 Key Functions
* **Filtering**: Search by City, Postal Code, NAF Code, or Date range.
* **Status**: Check if a company is **active**, **closed**, or **non-diffusible** (private).
* **Bulk Queries**: Retrieve lists of businesses matching specific economic criteria.

---

> [!IMPORTANT]
> **Privacy Note:** This API contains administrative data only. Direct contact info such as **phone numbers** or **personal emails** is not included.        
`,
        prompt: `To get French statistics data on companies, use the https://api.insee.fr/api-sirene/3.11 endpoints.`
    },*/


    // ========================================================================================================    
    {
        topic: "Enterprise Data (France)",
        name: "Recherche Entreprises",
        id: "recherche-entreprises",
        waitMs: 100,
        baseUrl: "https://recherche-entreprises.api.gouv.fr",
        description: "Official French aggregator (Sirene + RNE + Labels). Best for search companies and company leader names.",
        prompt: `Use \`https://recherche-entreprises.api.gouv.fr/search?q={query}\` for a textual search without location constraints.
        
Use \`https://recherche-entreprises.api.gouv.fr/near_point?lat={lat}&long={long}&radius={radius}\` for a location-based search where radius is in kilometers (default 5, max 50).

Additional (optional) parameters for both endpoints are:
- \`activite_principale\`: Code NAF exact (ex: 41.20Z)
- \`section_activite_principale\`: Lettre de section (ex: F pour Construction, C pour Industrie)
- \`tranche_effectif_salarie\`: Tranche INSEE (ex: 21 pour 50 à 99 salariés)
- \`categorie_entreprise\`: PME, ETI, GE
- \`code_postal\`: Filter by one or more postal codes.
- \`est_entrepreneur_individuel\`: true ou false
- \`est_organisme_formation\`: Entreprise de formation
- \`est_rge\`: Find companies with "Reconnu Garant de l'Environnement" label.
- \`est_ess\`: Filter for Social and Solidarity Economy (ESS) companies.
- \`est_bio\`: Certifié Agriculture Biologique
- \`nom_personne\`: Search for companies managed by a specific person.
- \`ca_min / ca_max\`: Filter by turnover (CA) in Euros.
- \`etat_administratif\`: A (Actif) ou C (Cessé)
- \`include\`: 'dirigeants', 'finances', 'complements' to include additional data in the response (multiple occurences allowed).
- \`page\`: Page number for pagination (starts at 1).
- \`per_page\`: Number of results per page (max 25).
`
    },

    // ========================================================================================================    
    {
        topic: "Global Business Search",
        name: "Overture Maps (Places API)",
        id: "overture-places",
        waitMs: "200",
        baseUrl: "https://api.overturemaps.org",
        description: "Worldwide business locations and Points of Interest (POI). A high-quality, open alternative to Google Maps Places, backed by Amazon, Meta, and Microsoft.",
        prompt: "Use Overture Maps to locate businesses and points of interest globally."
    },

    // ========================================================================================================    
    {
        topic: "Food & Product Data",
        name: "OpenFoodFacts API",
        id: "openfoodfacts",
        waitMs: "100",
        baseUrl: "https://world.openfoodfacts.org/api/v2",
        description: "Collaborative database of food products from around the world. Connects manufacturers (companies) to their specific products, ingredients, and nutritional scores.",
        prompt: "Search for products or scan barcodes to retrieve nutritional and manufacturing data."
    },

    // ========================================================================================================    
    {
        topic: "Global Business Lookup",
        name: "OpenCorporates",
        id: "opencorporates",
        apiKeyQueryParam: "api_token",
        rewriteRules: [
            ['decrypt-query-param', 'api_token'],
            ['inject-query-param', 'api_token', 'xxx']
        ],
        waitMs: 1000,
        baseUrl: "https://api.opencorporates.com/v0.4",
        description: "World's largest corporate database (200M+ companies).",
        prompt: "Use GET https://api.opencorporates.com/v0.4/companies/search?q={query}. Do not include the api_token query parameter because the proxy will inject it automatically."
    },

    // ========================================================================================================    
    {
        topic: "Global Economic Indicators",
        name: "World Bank Data API",
        id: "world-bank-data",
        waitMs: 100,
        baseUrl: "https://api.worldbank.org/v2",
        description: "GDP, inflation, and development stats for 200+ countries.",
        prompt: "Use GET https://api.worldbank.org/v2/country/{iso2code}/indicator/{indicatorCode}?format=json."
    },

    // ========================================================================================================    
    {
        topic: "Global Health Statistics",
        name: "WHO GHO API",
        id: "who-gho",
        waitMs: 200,
        baseUrl: "https://ghoapi.azureedge.net/api",
        description: "Life expectancy, mortality rates, and health indicators worldwide.",
        prompt: "Use GET https://ghoapi.azureedge.net/api/{IndicatorCode}."
    },

    // ========================================================================================================    
    {
        topic: "Global Demographics",
        name: "UN Population Data Portal",
        id: "un-population",
        waitMs: 200,
        baseUrl: "https://population.un.org/dataportalapi/api/v1",
        description: "Official UN population estimates and projections.",
        prompt: "Use GET https://population.un.org/dataportalapi/api/v1/data/indicators/{id}/locations/{locId}."
    },

    // ========================================================================================================    
    {
        topic: "Global Address Search",
        name: "Nominatim (OSM Geocoding)",
        id: "osm-nominatim",
        authType: "none",
        requiredReferer: "https://apps.daquota.io",
        requiredUserAgent: "daquota.io",
        waitMs: 1000,
        baseUrl: "https://nominatim.openstreetmap.org",
        description: "Official OpenStreetMap geocoder. Converts addresses to coordinates.",
        prompt: "Use GET https://nominatim.openstreetmap.org/search?q={query}&format=json. The proxy will provide a custom User-Agent header automatically."
    },
    /*{
        topic: "Global Maritime Tracking",
        name: "MarineTraffic API",
        id: "marinetraffic",
        waitMs: 2000,
        baseUrl: "https://services.marinetraffic.com/api",
        description: "Real-time vessel positions and ship details.",
        prompt: "Use GET https://services.marinetraffic.com/api/exportvessel/v:5/{apiKey}."
    },*/

    // ========================================================================================================    
    {
        topic: "Environmental Data",
        name: "OpenWeatherMap",
        id: "openweathermap",
        rewriteRules: [
            ['decrypt-query-param', 'appid'],
            ['inject-query-param', 'appid', 'LocalFlow']
        ],
        apiKeyQueryParam: "appid",
        waitMs: 500,
        baseUrl: "https://api.openweathermap.org/data/2.5",
        description: "Current weather and forecasts for any coordinate.",
        prompt: "Use GET https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lon}. Do not include the appid query parameter because the proxy will inject it automatically."
    },

    // ========================================================================================================    
{
        name: "Moteur Immo",
        topic: "French Real Estate",
        id: "moteur-immo",
        waitMs: 200,
        apiKeyQueryParamGetOnly: "apiKey",
        apiKeyBodyParam: "apiKey",
        baseUrl: "https://moteurimmo.fr/api",
        description: `Moteur Immo is a massive aggregator for the French real estate market, indexing listings from over 70 platforms (Leboncoin, SeLoger, PAP, Bien'ici, etc.) every 10 minutes. 
        Key features include:
        - **Advanced De-duplication**: Groups identical listings across multiple portals into a single "main" ad.
        - **Data Enrichment**: Automatically extracts DPE/GES ratings, charges, and calculates estimated profitability and price-per-sqm gaps versus local market medians.
        - **Historical Access**: Retains deleted/expired ads for 1 year and tracks price changes/republications.`,
        prompt: `Use \`https://moteurimmo.fr/api\` (Moteur Immo API) to search for active or historical real estate listings in France. 

### CORE ENDPOINTS
- **POST /ads**: Search for listings (active). Highly recommended for complex filtering.
- **GET /ad/{id}**: Retrieve a specific ad via uniqueId, URL, or origin/adId pair.
- **POST /deletedAds**: Search for ads removed from the market (minimalist format, free of charge).
- **POST /publishers**: Search for real estate professionals or individuals.

### SEARCH PARAMETERS (POST /ads) 
- **publisherTypes**: \`professional\`, \`individual\`. Default is \`['professional', 'individual']\`.
- **locations**: List of objects: \`{ "inseeCode": "..." }\`, \`{ "postalCode": "..." }\`, \`{ "coordinates": [longitude, latitude] }\`, or \`{ "departmentCode": 75 }\`.
- **radius**: Search radius in kilometers (possible values from 1 to 100).
- **box**: Bounding box defined by \`[[longitude, latitude], [longitude, latitude]]\` (top-left and bottom-right coordinates).
- **types**: Array containing \`"sale"\` or \`"rental"\`. Default is \`['sale', 'rental']\`.
- **categories**: \`house, flat, office, premises, shop, block (immeuble), land, parking/garage/box, misc\`. Default is \`['house', 'flat', 'office', 'premises', 'shop', 'block', 'land', 'parking/garage/box', 'misc']\`.
- **priceMin / priceMax**: Price in Euros.
- **pricePerSquareMeterMin / pricePerSquareMeterMax**: Price per m² in Euros.
- **rentMin / rentMax**: Monthly rent in Euros (for rentals).
- **propertyChargesMin / propertyChargesMax**: Monthly property charges in Euros (for rentals).
- **propertyTaxMin / propertyTaxMax**: Annual property (foncière) tax in Euros.
- **roomsMin / roomsMax**: Number of main rooms.
- **bedroomsMin / bedroomsMax**: Number of bedrooms.
- **surfaceMin / surfaceMax**: Living area in m².
- **landSurfaceMin / landSurfaceMax**: Land area in m².
- **constructionYearMin / constructionYearMax**: Year of construction.
- **floorMin / floorMax**: Floor number (for apartments).
- **buildingFloorsMin / buildingFloorsMax**: Total number of floors in the building (for apartments).
- **energyGradeMin / energyGradeMax**: DPE energy rating from in \`['A', 'B', 'C', 'D', 'E', 'F', 'G', 'V']\`.
- **energyValueMin / energyValueMax**: DPE energy consumption in kWh/m²/year between 1 and 1000.
- **gasGradeMin / gasGradeMax**: DPE greenhouse gas rating in \`['A', 'B', 'C', 'D', 'E', 'F', 'G', 'V']\`.
- **gasValueMin / gasValueMax**: DPE greenhouse gas emissions in kgCO2/m²/year between 1 and 1000.
- **options**: Boolean filters like \`hasLift\`, \`hasGarden\`, \`isNew\`, \`hasWorksRequired\`, \`knownPosition\`, or \`denyProspecting\`.
- **keywords**: Array of strings to search in title and description.
- **keywordOperator**: \`and\` (default) or \`or\` to combine multiple keywords.
- **sortBy**: \`creationDate-desc\` (default), \`price-asc\`, \`lastPriceChangeDate-desc\`, \`lastChangeDate-desc\`.

### RESPONSE SCHEMA (Ad Object)
\`\`\`typescript
interface MoteurImmoAd {
  uniqueId: string;
  title: string;
  description: string;
  price: number;
  surface: number;
  rooms: number;
  location: {
    city: string;
    postalCode: string;
    inseeCode: string;
    coordinates: [number, number]; // [Longitude, Latitude]
    isRightLocation: boolean;      // True if the location was verified in text
  };
  priceStats: {
    profitability: number;  // Estimated yield (e.g., 0.05 for 5%)
    medianPrice: number;     // Local median price per m²
    priceGap: number;        // Gap percentage vs median
  };
  energyGrade: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  url: string;               // Direct link to source
  duplicates: Array<{ origin: string; url: string; price: number }>;
  history?: Array<{ action: string; date: string; differences: any }>;
}
\`\`\`

*IMPORTANT*: Pagination is restricted to the first 10,000 ads. To fetch older data, use \`creationDateBefore\` filters to create time intervals.`
    },

    // ========================================================================================================
    // LOCALFLOW APIs (private)    
    // ========================================================================================================    
    {
        name: "DVF (Demandes de Valeurs Foncières)",
        topic: "French Real Estate",
        id: "dvf-api",
        baseUrl: "https://gis.daquota.io/dvf",
        rewriteRules: [
            // The public URL api.daquota.io/dvf rewrites to your server's internal listener
            ['replace', 'https://gis.daquota.io/dvf', 'http://195.154.104.134:8889/dvf']
        ],
        description: `This API provides access to official French real estate transaction data (DVF) from Etalab. It includes over 18 million records of property sales, including prices, dates, surface areas, and room counts, geolocated and indexed for high-speed spatial proximity searches.`,
        prompt: `Use the DVF API \`https://gis.daquota.io/dvf\` to retrieve historical real estate sales data in France. 

### SEARCH CRITERIA
You must provide at least one of the following filters:
- **Spatial**: \`lat\`, \`lon\`, and \`dist\` (distance in meters, max 2000).
- **Administrative**: \`code_postal\` (5 digits) or \`code_commune\` (5 digits).
- **Cadastral**: \`id_parcelle\` (14 digits).

### OPTIONAL FILTERS
- \`type_local\`: Filter by "Maison", "Appartement", "Local industriel", or "Dépendance".
- \`nature_mutation\`: Filter by "Vente", "Echange", or "Adjudication".

### EXAMPLE RESULT
\`\`\`json
{"source" : "Etalab / Demande de Valeurs Foncières Géolocalisées", "type" : "FeatureCollection", "features" : [{"type" : "Feature", "geometry" : {"type":"Point","coordinates":[5.1102,46.401982]}, "properties" : {"id_mutation":"2022-12446","date_mutation":"2022-10-04","numero_disposition":"000001","nature_mutation":"Vente","valeur_fonciere":190000,"adresse_numero":"15","adresse_nom_voie":"PL DU MARCHE","adresse_code_voie":"0135","code_postal":"01560","code_commune":"01367","nom_commune":"Saint-Julien-sur-Reyssouze","code_departement":"01","id_parcelle":"013670000A1059","nombre_lots":0,"code_type_local":"1","type_local":"Maison","surface_reelle_bati":62,"nombre_pieces_principales":3,"code_nature_culture":"S","nature_culture":"sols","surface_terrain":421,"longitude":5.1102,"latitude":46.401982,"geom":{"type":"Point","crs":{"type":"name","properties":{"name":"EPSG:4326"}},"coordinates":[5.1102,46.401982]}}}...
\`\`\`

*IMPORTANT*: Use the spatial search (\`lat/lon\`) for proximity analysis. Use the \`id_parcelle\` search for deep-dives into specific building history.`
    },

];

try {
    const jsonContent = JSON.stringify(configData, null, 2);
    // Use '..' to go up one level from the 'scripts' folder
    const outputPath = path.join(__dirname, '..', 'api-config.json');

    fs.writeFileSync(outputPath, jsonContent, 'utf8');
    console.log(`✅ Success: api-config.json has been generated at: ${outputPath}`);
} catch (error) {
    console.error('❌ Error generating JSON:', error.message);
    process.exit(1);
}