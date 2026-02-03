const fs = require('fs');
const path = require('path');

const configData = [
  {
    name: "OverPass",
    topic: "Spatial analysis",
    id: "overpass",
    baseUrl: 'https://overpass-api.de/api/interpreter',
    rewriteRules: [
        [
            'replace', 'https://overpass-api.de/api/interpreter?', 'https://overpass.geofabrik.de/fa30b3dbaceb457ba9748173ff24da48/api/interpreter?'
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
    rewriteRules: [
        [
            'replace', 'https://routing.openstreetmap.de/', 'https://routing.geofabrik.de/308fc7330c8c4e54a89a995eb2bb4fee/',
            'replace', 'https://router.project-osrm.org', 'https://routing.geofabrik.de/308fc7330c8c4e54a89a995eb2bb4fee/'
        ]
    ],
    force: true,
    prompt: `Use OSRM to calculate distance and time by transportation. The base url is \`https://routing.openstreetmap.de\`.`,     
    description: `OSRM is the Open Source engine for routing. It can be used to calculate itineraries or find the distance and time between two points by any transportation means.`
  },
  {
    name: "IGN",
    topic: "Advanced",
    id: "ign",
    waitMs: "100",
    baseUrl: 'https://data.geopf.fr/wfs/ows',
    description: "The French IGN geo platform, which allows you to access any data in the IGN GIS. This is Open Data.",
    prompt: `For France and very specific government data, use the IGN API 
    https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=wfs_sup:assiette_sup_s&BBOX=49.10,0.18,49.18,0.28&&OUTPUTFORMAT=application/json 
    and replace the type and bounding box parameters. 
    
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
        topic: "Elevation",
        name: "Open Meteo Elevation",
        id: "elevation",
        baseUrl: "https://api.open-meteo.com/v1/elevation",
        rewriteRules: [
            ['replace', "https://api.open-meteo.com/v1/elevation?", 'https://customer-api.open-meteo.com/v1/elevation?apikey=wVQs28qlP99RxDRm&']
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