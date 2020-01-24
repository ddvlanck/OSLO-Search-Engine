// Elasticsearch data and index creation
require('es6-promise').polyfill();
require('isomorphic-fetch');
const SitemapGenerator = require('advanced-sitemap-generator');
const xml2js = require('xml2js');
const fs = require('fs');
const Parser = new xml2js.Parser({attrkey: "ATTR"});
const elasticsearch = require('elasticsearch');
const getHrefs = require('get-hrefs');
const cron = require("node-cron");
const XMLWriter = require('xml-writer');

const config = require('./config.js');

//TODO
// 1. Dockerize the project
// 2. Store data in a semantic (triples) way in Elasticsearch

try {
    test();
    //setup();
    //addToSitemap(['https://data.vlaanderen.be/ns/adres', 'https://data.vlaanderen.be/doc/applicatieprofiel/adresregister/']);
    // cron job is executed: “At 00:00 on day-of-month 1 in every month.”
    //cron.schedule("0 0 1 */1 *", function() {
    //    update();
    //});

} catch (e) {
    console.error('Something went wrong!');
    console.log(e);
}

async function test(){
    let [indexed_urls, indexed_fis] = await indexData();

    // Create Elasticsearch client and an index
    const client = createElasticsearchClient();
    createElasticsearchIndex(client, config.URL_INDEX);
    createElasticsearchIndex(client, config.FRAGMENT_IDENTIFIER_INDEX);


    // Add data in bulk mode to Elasticsearch
    addDataInBulk(client, indexed_urls, config.URL_INDEX, config.URL_TYPE);
    addDataInBulk(client, indexed_fis, config.FRAGMENT_IDENTIFIER_INDEX, config.FRAGMENT_IDENTIFIER_TYPE);
}


/*
*
* This function is executed the first time the application is started.
* A sitemap is generated, Elasticsearch indices are created and data is pushed to the engine
*
* */
function setup() {
    const generator = createSitemapGenerator(config.ORIGINAL_SITEMAP);

    generator.on('done', async () => {
        //await deleteIdentifierURLs(config.ORIGINAL_SITEMAP);

        // Index the sitemap
        let [indexed_urls, indexed_fis] = await indexData();

        // Create Elasticsearch client and an index
        /*const client = createElasticsearchClient();
        createElasticsearchIndex(client, config.URL_INDEX);
        createElasticsearchIndex(client, config.FRAGMENT_IDENTIFIER_INDEX);


        // Add data in bulk mode to Elasticsearch
        addDataInBulk(client, indexed_urls, config.URL_INDEX, config.URL_TYPE);
        addDataInBulk(client, indexed_fis, config.FRAGMENT_IDENTIFIER_INDEX, config.FRAGMENT_IDENTIFIER_TYPE);*/

    });

    generator.start();
}

/*
*
* This function is executed by the cron job.
* It starts the sitemap generator, compares the old and new sitemap en pushes new URLs to Elasticsearch.
*
* */
async function update() {
    const generator = createSitemapGenerator(config.UPDATE_SITEMAP);

    generator.on('done', async () => {
        await deleteIdentifierURLs(config.UPDATE_SITEMAP);
        const newURLs = await compareToOriginalSiteMap();
        const newIndexedURLs = convertURLsToJSON(newURLs);
        const newIndexedFIs = await getFragmentIdentifiers(newURLs);

        const client = createElasticsearchClient();
        addDataInBulk(client, newIndexedURLs, config.URL_INDEX, config.URL_TYPE);
        addDataInBulk(client, newIndexedFIs, config.FRAGMENT_IDENTIFIER_INDEX, config.FRAGMENT_IDENTIFIER_TYPE);
    });

    generator.start();
}


/*
* Creates a generator instance to create a sitemap.xml file
* */
function createSitemapGenerator(filename) {

    // Create sitemap generator for data.vlaanderen.be
    const generator = SitemapGenerator('https://data.vlaanderen.be', {
        stripQuerystring: true,
        ignoreHreflang: true,
        filepath: filename,
        excludeURLs: ['/doc/adres', '/doc/organisatie', '/id/adres', '/id/organisatie']   // Which patterns should be excluded
    });
    // Since we exclude patterns with 'adres' and 'organisatie' to prevent we crawl the address and organization register (datasets)
    // We have to add their application profiles and vocs manually.

    return generator;
}


/*
* Called in the main method and CRON job to create an Elasticsearch client
* */
function createElasticsearchClient() {
    console.log('\x1b[33m%s\x1b[0m ', "Creating an Elasticsearch client.");

    const client = new elasticsearch.Client({
        hosts: [config.ELASTICSEARCH_HOST]
    });

    console.log('\x1b[33m%s\x1b[0m ', "Pinging Elastichsearch client to be sure the service is running.");

    // Ping the client to be sure Elasticsearch is up
    client.ping({
        requestTimeout: 30000,
    }, function (error) {
        // At this point, eastic search is down, please check your Elasticsearch service
        if (error) {
            console.error('\x1b[31m%s\x1b[0m ', "Elasticsearch cluster is down")
        } else {
            console.log('\x1b[32m%s\x1b[0m ', "Elasticsearch cluster/client is running");
        }
    });

    return client;
}

/*
* Creates an index in Elasticsearch
* @params {client} :  an Elasticsearch client
* @params {name} : the name of the index
* */
function createElasticsearchIndex(client, name) {
    client.indices.create({
        index: name
    }, function (error, response, status) {
        if (error) {
            console.log(error);
        } else {
            console.log("Created a new index: " + name, response);
        }
    });
}

/*
* Pushes data in bulk mode to the Elasticsearch engine
* @params {client} : an Elasticsearch client
* @params {data} : array with JSON objects
* @params {index} : index where data will be stored
* @params {type} : type of the data
* */
function addDataInBulk(client, data, index, type) {

    // Declare an empty array called bulk
    let bulk = [];

    // Loop through each URL and create and push two objects into the array in each loop
    // first object sends the index and type you will be saving the data as
    // second object is the data you want to index
    data.forEach(url => {
        bulk.push({
            index: {
                _index: index,
                _type: type,
            }
        })
        bulk.push(url)
    });

    // Perform bulk indexing of the data passed
    client.bulk({body: bulk}, function (err, response) {
        if (err) {
            console.log("Failed Bulk operation ", err)
        } else {
            console.log("Successfully imported ", data.length);
        }
    });

}


/*
* Reads all URLs from the sitemap.xml file and executes two functions.
* The first function converts to URLs to JSON objects with metadata.
* The second function gets all the fragment identifiers present in the HTML body of the URL
* */
async function indexData() {
    const data = await XMLToJSON(config.ORIGINAL_SITEMAP);

    let indexedURLs = convertURLsToJSON(data.urlset.url);
    let indexedFIs = await getFragmentIdentifiers(data.urlset.url);

    return [indexedURLs, indexedFIs];
}

/*
* Compares the original sitemap to the new sitemap. New URLs are extracted and returned by this function
* New sitemap overrides old sitemap.
* */
async function compareToOriginalSiteMap() {
    let originalURLs = await XMLToJSON(config.ORIGINAL_SITEMAP);
    const convertedOriginalURLs = originalURLs.urlset.url.map(a => a.loc[0]);

    let update = await XMLToJSON('test.xml');

    // Compare two sitemaps so that we only have to push new URLs to Elasticsearch
    let newURLs = [];
    update.urlset.url.forEach(url => {
        if (!convertedOriginalURLs.includes(url.loc[0])) {
            originalURLs.push(url);
            newURLs.push(url);
        }
    });

    // Write originalData (which can be updated) back to sitemap.xml
    const xw = new XMLWriter(true);
    xw.startDocument('1.0', 'UTF-8', 'yes');
    xw.startElement('urlset');

    for (let i = 0; i < URLs.urlset.url.length; i++) {
        xw.startElement('url')
            .writeElement('loc', URLs.urlset.url[i].loc[0])
            .writeElement('changefreq', URLs.urlset.url[i].changefreq[0])
            .writeElement('priority', URLs.urlset.url[i].priority[0])
            .writeElement('lastmod', URLs.urlset.url[i].lastmod[0]);
        xw.endElement();
    }
    xw.endDocType();
    fs.createWriteStream(config.ORIGINAL_SITEMAP).write(xw.toString());

    // Delete the sitemap-update.xml file
    fs.unlinkSync('./sitemap-update.xml');

    return newURLs;
}

/*
* Converts URLs to JSON objects with metadata
* @params {urls}: list of objects containing the URLs (output from XML converter)
* */
function convertURLsToJSON(urls) {
    let indexedURLs = [];
    for (let index in urls) {

        // Create JSON objects for the sitemap.xml
        let object = {};
        object.url = urls[index].loc[0];
        object.keywords = createKeywords(object.url);
        object.priority = urls[index].priority[0];
        object.lastmod = urls[index].lastmod[0];
        object.type = urlType(object.url);
        indexedURLs.push(object);

    }
    return indexedURLs
}

/*
* Gets all fragment identifiers for the list of URLs
* @params {urls}: list of objects containing the URLs (output from XML converter)
* */
async function getFragmentIdentifiers(urls) {
    let FIs = [];
    for (let index in urls) {
        let FI = await getFragmentIdentifiersForURL(urls[index].loc[0]);
        FIs = FIs.concat(FI);
    }
    return FIs;
}

/*
* Actual function that retrieves the fragment identifiers present in the HTML body of the URL
* Creates an array of JSON objects containing the fragment identifier and information about the identifier.
* @params {url} : a URL
* */
async function getFragmentIdentifiersForURL(url) {
    let html = await fetch(url).then(res => {
        return res.text()
    });
    let hrefs = getHrefs(html);
    hrefs = hrefs.filter(href => href.indexOf('#') === 0);  // Only keep fragment identifiers from this URL. (not those who refer to another domain);

    let fragmentIdentifiers = [];

    hrefs.forEach(fi => {

        if (!config.INVALID_FRAGMENTS_IDENTIFIERS.includes(fi)) {
            // Remove any hexidecimal signs (%3A is a [point]. %20 represents a space and can not be removed in the URL. However, for the keywords, it will be removed)
            const fi_pretty = fi.replace('%3A', '.');

            // Determine if the fragment identifier points to a property, class (or json-ld context)
            let isProperty = false;
            // Term is a property if it starts with lowercase or a point occurs in the string
            if (fi_pretty.charAt(1) == fi_pretty.charAt(1).toLowerCase() || fi_pretty.indexOf('.') >= 0) {
                isProperty = true;
            }

            // Get name of the term
            let name = fi_pretty.split('.').length > 1 ? fi_pretty.substr(fi_pretty.indexOf('.') + 1, fi_pretty.length) : fi_pretty.substr(1, fi_pretty.length);
            name = name.replace(/%20/g, ' ');

            // Generate keywords that will be queried
            const keywords = fi_pretty.replace(/%20/g, ' ').substring(1, fi_pretty.length).split('.');

            // Determine type of term
            let type;
            if (fi_pretty.indexOf('jsonld') >= 0) {
                type = 'Context';

                //If FI is jsonld context, it means the URL is of an applicationprofile (AP)
                // So we add the name of the AP
                let apName = url.substring(url.indexOf('applicatieprofiel') + 18, url.length - 1);
                keywords.push(apName);

                // We also change the name of the object (otherwise its name will be 'jsonld')
                name = 'JSON-LD context van ' + apName;

            } else {
                type = isProperty ? 'Eigenschap' : 'Klasse';
            }

            // If we have a JSON-LD context, we need to construct the proper URL for it
            // Otherwise we construct the regular URL by preceding the FI with https://data.vlaanderen.be/...
            let URL;
            if (type === 'Context') {

                // We must take into account the two version of the toolchain.
                // For the new version of the toolchain, the URI structure is different

                // For the OLD version, URLs end with '/'
                if(url.charAt(url.length) === '/'){
                    URL = 'https://data.vlaanderen.be/context/' + keywords[keywords.length - 1] + '.jsonld';
                } else {
                    URL = url + 'context/' + keywords[keywords.length - 1] + '.jsonld'
                }


            } else {
                URL = url + fi; // 'url' is the parameter of the function
                                // Here we is variable 'fi' because URL needs to contain the hexidecimal numbers for points and spaces
            }

            fragmentIdentifiers.push(
                {
                    url: URL,
                    keywords: keywords,
                    type: type,
                    name: name
                });
        }
    });

    return fragmentIdentifiers;
}

/*
* Creates the keywords for the URL that will be pushed to Elasticsearch
* @param {url}: a URL
* */
function createKeywords(url) {
    // Remove the base domain and use other parts as keywords
    // Main website has no other parts, so we define them ourselves
    if (url === 'https://data.vlaanderen.be/') {
        return ['data', 'vlaanderen', 'be'];
    } else if (url === 'https://data.vlaanderen.be/ns') {
        let keywords = url.replace('https://data.vlaanderen.be/', '').split('/');
        keywords.push('vocabularium', 'applicatieprofiel');
    } else {
        return url.replace('https://data.vlaanderen.be/', '').split('/');
    }

}

/*
* Determines the type of the URL and will be added as metadata to the corresponding JSON object
* @param {url}: a URL
* */
function urlType(url) {
    let type = "Pagina of document";    // Each URL is a page or document

    // Check if we can add a more detailed type
    if (url.indexOf('/standaarden/') >= 0) {
        type = "Status in standaardenregister";
    } else if (url.indexOf('/applicatieprofiel/') >= 0) {
        type = "Applicatieprofiel"
    } else if (url.indexOf('/ns/') >= 0) {
        type = "Vocabularium"
    } else if (url.indexOf('/conceptscheme/') >= 0) {
        type = "Codelijst"
    } else if (url.indexOf('/concept/') >= 0) {
        type = "Waarde van een codelijst"
    }

    // Specific Web pages
    if (url === 'https://data.vlaanderen.be/') {
        type = "Hoofdpagina"
    } else if (url === 'https://data.vlaanderen.be/dumps') {
        type = "Data dumps";
    } else if (url === 'https://data.vlaanderen.be/ns') {
        type = "Namespace met alle vocabularia en applicatieprofielen";
    } else if (url === 'https://data.vlaanderen.be/standaarden') {
        type = "Standaardenregister";
    }

    return type;
}

/*
* Deletes all the URLs that have /id/ in their path. We can't exclude these URLs in the generator because otherwise URLs that need to be in the sitemap
* are not. So we remove them here and rewrite the sitemap.
* @params {sitemap}: name of the XML sitemap whose identifiers URLs are to be deleted
*
* NOTE: in this function also wrong URLs are deleted.
* Apparently wrong URLs are formed by the sitemap-generator, e.g. https://data.vlaanderen.be/ns/www.cipalschoubroek.be
* These URLs need to be removed
* */
async function deleteIdentifierURLs(sitemap) {
    let URLs = await XMLToJSON(sitemap);

    const xw = new XMLWriter(true);
    xw.startDocument();
    xw.startElement('urlset');

    for (let i = 0; i < URLs.urlset.url.length; i++) {
        let URL = URLs.urlset.url[i].loc[0];

        if (URL.indexOf('/id/') < 0 && URL.substring(URL.lastIndexOf('/'), URL.length).indexOf('www.') < 0) {
            xw.startElement('url')
                .writeElement('loc', URLs.urlset.url[i].loc[0])
                .writeElement('changefreq', URLs.urlset.url[i].changefreq[0])
                .writeElement('priority', URLs.urlset.url[i].priority[0])
                .writeElement('lastmod', URLs.urlset.url[i].lastmod[0]);
            xw.endElement();
        }
    }
    xw.endDocType();
    fs.createWriteStream(sitemap).write(xw.toString());
}

/*
* Function that converts XML data to JSON data
* @params {sitemap}: name of the XML sitemap whose data is to be converted
* */
function XMLToJSON(sitemap) {
    return new Promise(resolve => {
        fs.readFile(sitemap, (err, xmlString) => {
            if (err) {
                console.error('Error reading the sitemap.xml file');
            }
            Parser.parseString(xmlString.toString(), (err, res) => {
                if (err) {
                    console.error(err);
                }
                resolve(res);

            });
        });
    });
}


