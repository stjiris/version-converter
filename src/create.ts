import { MappingProperty } from "@elastic/elasticsearch/lib/api/types";
import { argv, argv0 } from "process";
import { client } from "./util/client";
import {getVersion, getVersions} from "./util/Version"

export let PACKAGE_NAMES = [
    "jurisprudencia-document-9",
    "jurisprudencia-document-10-alpha",
    "jurisprudencia-document-11"
]

let DELETE_INDEX = argv.includes("--delete");

let HELP = argv.includes("--help");

async function showHelp(code: number, error?: string){
    if( error ){
        process.stderr.write(error);
        process.stderr.write("\n");
    }
    process.stdout.write(`Usage: ${argv0} ${__filename} [OPTIONS] <index>\n`)
    process.stdout.write(`Create Jurisprudencia index.\n`)
    process.stdout.write(`Use ES_URL, ES_USER and ES_PASS environment variables to setup the elasticsearch client\n`)
    process.stdout.write(`Options:\n`)
    process.stdout.write(`\t--delete\trecreates the index if it already exists [deletes the content]\n`)
    process.stdout.write(`\t--help\t\tshow this help\n`)

    await getVersions().then(vs => {
        process.stdout.write(`Available index values:\n`);
        process.stdout.write(vs.map(v => v.JurisprudenciaVersion).join(", "));
        process.stdout.write("\n");
    })

    process.exit(code);
}

async function main(){
    if( HELP ) return await showHelp(0)
    let versions = argv.filter(arg => arg.startsWith("jurisprudencia."));
    if( versions.length == 0 || versions.length > 1 ) return await showHelp(1, "ERROR: Select exacly ONE of the available index values\n");
    let v = await getVersion(versions[0]);
    if( !v ) return await showHelp(1, `ERROR: Unable to use index "${versions[0]}"\n`);
    let version = v;
    client.indices.exists({index: version.JurisprudenciaVersion}).then( async exists => {
        if(exists && !DELETE_INDEX){
            process.stdout.write(`Index "${version.JurisprudenciaVersion}" already exists.\n`)
            let stats = await client.indices.stats({index: version.JurisprudenciaVersion});
            process.stdout.write(`Status:    \t${stats.indices ? stats.indices[version.JurisprudenciaVersion].health : "n.a."}\n`)
            process.stdout.write(`Total docs:\t${stats.indices ? stats.indices[version.JurisprudenciaVersion].total?.docs?.count : "n.a."}\n`)
            return;
        }
        if( exists && DELETE_INDEX ){
            process.stdout.write(`Deleting current indice "${version.JurisprudenciaVersion}".\n`)
            let r = await client.indices.delete({index: version.JurisprudenciaVersion});
            process.stdout.write(`Result:    \t${r.acknowledged}\n`);
        }
        let r = await client.indices.create({
            index: version.JurisprudenciaVersion,
            mappings: {
                dynamic_date_formats: ['dd/MM/yyyy'],
                properties: version.JurisprudenciaProperties as Record<string, MappingProperty>
            },
            settings: {
                analysis: {
                    normalizer: {
                        term_normalizer: {
                            type: 'custom',
                            filter: ['uppercase', 'asciifolding']
                        }
                    },
                    analyzer: {
                        default: {
                            type: "custom",
                            char_filter: ['html_strip'],
                            filter: ['trim', 'lowercase', 'stopwords_pt', 'asciifolding'],
                            tokenizer: 'classic',
                        }
                    },
                    filter: {
                        stopwords_pt: {
                            type: 'stop',
                            ignore_case: true,
                            stopwords_path: "stopwords_pt.txt"
                        }
                    }
                },
                number_of_shards: 1,
                number_of_replicas: 0,
                max_result_window: 550000
            }
        })
        process.stdout.write(`Created ${r.index} with result: ${r.acknowledged}.\n`);
    }).catch(e => showHelp(2, `ERROR: ${e.name}\n`))
    
}

main().catch(e => console.error(e))