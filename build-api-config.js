const fs = require('fs');
const path = require('path');

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
                'replace', 'https://overpass-api.de/api/interpreter?', 'https://overpass.geofabrik.de/{apiKey}/api/interpreter?'
            ]
        ],
        force: true,
        description: `OpenStreetMap's OverPass API allows to access most data that can be put on a map worldwide. For example: roads, forests, buildings, rivers, lakes, infrastructures, ...`,
        prompt: `Use OpenStreetMap's OverPass API (*HIGHLY PREFERED*) and Turf.js (available in \`turf\`). Example: find closest rivers and calculate distance. When using Overpass, remember the BBOX order is (south, west, north, east).`
    },
    {
        name: "OSRM",
        Topic: "Routing",
        id: "osrm",
        baseUrl: ['https://routing.openstreetmap.de', 'https://router.project-osrm.org'],
        apiKeyRoutePlaceholder: '{apiKey}',
        apiKey: '308fc7330c8c4e54a89a995eb2bb4fee',
        rewriteRules: [
            [
                'replace', 'https://routing.openstreetmap.de/', 'https://routing.geofabrik.de/{apiKey}/',
                'replace', 'https://router.project-osrm.org', 'https://routing.geofabrik.de/{apiKey}/'
            ]
        ],
        force: true,
        prompt: `Use OSRM to calculate distance and time by transportation. The base url is \`https://routing.openstreetmap.de\`.`,
        description: `OSRM is the Open Source engine for routing. It can be used to calculate itineraries or find the distance and time between two points by any transportation means.`
    },
    {
        name: "Geoplateforme IGN",
        topic: "Advanced",
        id: "ign",
        waitMs: "100",
        baseUrl: ['https://data.geopf.fr/wfs/ows', 'https://wfs.geoportail-urbanisme.gouv.fr/wfs'],
        description: "The French IGN geo platform, which allows you to access any data in the IGN GIS. This is Open Data. Note that `https://wfs.geoportail-urbanisme.gouv.fr` is deprecated but still active for backward compatibility.",
        prompt: `For France and very specific government data, use the IGN API https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_sup:assiette_sup_s&BBOX=49.10,0.18,49.18,0.28&&OUTPUTFORMAT=application/json and replace the type and bounding box parameters. 
    
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
* \`BDTOPO_V3:terrain_de_sport\`, 
* \`BDTOPO_V3:zone_de_vegetation\``
    },
    {
        name: "APICarto",
        topic: "Advanced",
        id: "apicarto",
        waitMs: "100",
        baseUrl: 'https://apicarto.ign.fr/api',
        description: `
L'API Carto est une API OpenData IGN.

## 🛠 Les modules disponibles

| Module | Description | Lien |
| :--- | :--- | :--- |
| **Cadastre** | Accès aux données cadastrales (commune, division, parcelle, etc.). | [Documentation API](./cadastre) |
| **Limites Administratives** | Récupération des données administratives (commune, département, région). | [Documentation API](./limites-administratives) |
| **Codes Postaux** | Récupération des communes en fonction d'un code postal. | [Documentation API](./codes-postaux) |
| **Urbanisme (GpU)** | Accès aux données du Géoportail de l'Urbanisme (PLU, POS, CC, SUP). | [Documentation API](./gpu) |
| **RPG** | Accès aux données du Registre Parcellaire Graphique (cultures). | [Documentation API](./rpg) |
| **WFS-Geoportail** | Accès générique à n'importe quel flux WFS du Géoportail. | [Documentation API](./wfs-geoportail) |
| **Nature** | Accès aux flux s'appuyant sur des données du MNHN. | [Documentation API](./nature) |
| **AOC** | Accès aux données des Appellations d'Origine Contrôlée. | [Documentation API](./aoc) |
        `,
        prompt: `For France and specific government data, use the APICarto API (https://apicarto.ign.fr/api) with the appropriate module (cadastre, limites-administratives, codes-postaux, gpu, rpg, wfs-geoportail, nature, aoc). Each module API is available at https://apicarto.ign.fr/api/{module} and documented at https://apicarto.ign.fr/api/doc/{module}.`
    },
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
        description: "Open Meteo Elevation is a service to get the elevation worldwide.",
        prompt: `Use Open Meteo Elevation API (available at \`https://api.open-meteo.com/v1/elevation\`) when the analysis requires elevation on many objets. Example: show topology around a point.`
    },
    {
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
        topic: "Photovoltaic Data",
        name: "PVGIS (Photovoltaic Geographical Information System)",
        id: "pvgis",
        waitMs: "500",
        baseUrl: ["https://re.jrc.ec.europa.eu/api"],
        description: "PVGIS (Photovoltaic Geographical Information System), a service provided by the Joint Research Centre (JRC) of the European Commission.",
        prompt: `Use PVGIS to get photovoltaic data. Available endpoints are documented at https://re.jrc.ec.europa.eu/api/v5_2/`
    },
    {
        topic: "Administrative Boundaries",
        name: "French Administrative Boundaries (geo.api.gouv.fr)",
        id: "geo-api-gouv-fr",
        waitMs: "100",
        baseUrl: "https://geo.api.gouv.fr/",
        description: "Get French administrative boundaries for communes, departments, regions, etc.",
        prompt: `To get French administrative boundaries, use the https://geo.api.gouv.fr/ endpoints.`
    },
    {
        topic: "Demographics & Local Stats",
        name: "INSEE Melodi (Local Data)",
        id: "insee-melodi",
        waitMs: "500",
        baseUrl: "https://api.insee.fr/donnees-locales/v1",
        apiKeyHeader: "X-INSEE-Api-Key-ID",        
        //apiKeyHeader: "Authorization",
        description: "Socio-economic data at the local level: population density, age brackets, housing types, and employment stats by city or area.",
        prompt: "Use the INSEE Melodi API to retrieve demographic statistics for specific French territories."
    },
    {
        topic: "Macro-economic Indicators",
        name: "INSEE BDM (Economic Series)",
        id: "insee-bdm",
        waitMs: "500",
        baseUrl: "https://api.insee.fr/series/v1",
        apiKeyHeader: "X-INSEE-Api-Key-ID",        
        //apiKeyHeader: "Authorization",
        description: "Time-series data for the French economy. Includes the Consumer Price Index (Inflation), GDP growth, and construction cost indices.",
        prompt: "Query economic indices and time series data via the INSEE BDM endpoints."
    },
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

    {
        topic: "Enterprise Data (France)",
        name: "Recherche Entreprises",
        id: "recherche-entreprises",
        waitMs: 100,
        baseUrl: "https://recherche-entreprises.api.gouv.fr",
        description: "Official French aggregator (Sirene + RNE + Labels). Best for search bars and company leader names.",
        prompt: "Use GET https://recherche-entreprises.api.gouv.fr/search?q={query}."
    },
    {
        topic: "Global Business Search",
        name: "Overture Maps (Places API)",
        id: "overture-places",
        waitMs: "200",
        baseUrl: "https://api.overturemaps.org",
        description: "Worldwide business locations and Points of Interest (POI). A high-quality, open alternative to Google Maps Places, backed by Amazon, Meta, and Microsoft.",
        prompt: "Use Overture Maps to locate businesses and points of interest globally."
    }, 
    {
        topic: "Food & Product Data",
        name: "OpenFoodFacts API",
        id: "openfoodfacts",
        waitMs: "100",
        baseUrl: "https://world.openfoodfacts.org/api/v2",
        description: "Collaborative database of food products from around the world. Connects manufacturers (companies) to their specific products, ingredients, and nutritional scores.",
        prompt: "Search for products or scan barcodes to retrieve nutritional and manufacturing data."
    },       
    {
        topic: "Global Business Lookup",
        name: "OpenCorporates",
        id: "opencorporates",
        apiKeyQueryParam: "api_token",
        rewriteRules: [
            [ 'decrypt-query-param', 'api_token' ],
            [ 'inject-query-param', 'api_token', 'xxx']
        ],
        waitMs: 1000,
        baseUrl: "https://api.opencorporates.com/v0.4",
        description: "World's largest corporate database (200M+ companies).",
        prompt: "Use GET https://api.opencorporates.com/v0.4/companies/search?q={query}. Do not include the api_token query parameter because the proxy will inject it automatically."
    },
    {
        topic: "Global Economic Indicators",
        name: "World Bank Data API",
        id: "world-bank-data",
        waitMs: 100,
        baseUrl: "https://api.worldbank.org/v2",
        description: "GDP, inflation, and development stats for 200+ countries.",
        prompt: "Use GET https://api.worldbank.org/v2/country/{iso2code}/indicator/{indicatorCode}?format=json."
    },
    {
        topic: "Global Health Statistics",
        name: "WHO GHO API",
        id: "who-gho",
        waitMs: 200,
        baseUrl: "https://ghoapi.azureedge.net/api",
        description: "Life expectancy, mortality rates, and health indicators worldwide.",
        prompt: "Use GET https://ghoapi.azureedge.net/api/{IndicatorCode}."
    },
    {
        topic: "Global Demographics",
        name: "UN Population Data Portal",
        id: "un-population",
        waitMs: 200,
        baseUrl: "https://population.un.org/dataportalapi/api/v1",
        description: "Official UN population estimates and projections.",
        prompt: "Use GET https://population.un.org/dataportalapi/api/v1/data/indicators/{id}/locations/{locId}."
    },
    {
        topic: "Global Address Search",
        name: "Nominatim (OSM Geocoding)",
        id: "osm-nominatim",
        authType: "none",
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
    {
        topic: "Environmental Data",
        name: "OpenWeatherMap",
        id: "openweathermap",
        rewriteRules: [
            [ 'decrypt-query-param', 'appid' ],
            [ 'inject-query-param', 'appid', 'xxx']
        ],
        apiKeyQueryParam: "appid",
        waitMs: 500,
        baseUrl: "https://api.openweathermap.org/data/2.5",
        description: "Current weather and forecasts for any coordinate.",
        prompt: "Use GET https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lon}. Do not include the appid query parameter because the proxy will inject it automatically."
    }

];

try {
    const jsonContent = JSON.stringify(configData, null, 2);
    fs.writeFileSync(path.join(__dirname, 'api-config.json'), jsonContent, 'utf8');
    console.log('✅ Success: api-config.json has been generated.');
} catch (error) {
    console.error('❌ Error generating JSON:', error.message);
    process.exit(1);
}