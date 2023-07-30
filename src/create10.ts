import { MappingProperty } from "@elastic/elasticsearch/lib/api/types";
import { JurisprudenciaDocumentProperties as JurisprudenciaDocumentProperties10, JurisprudenciaVersion as JurisprudenciaVersion10 } from "jurisprudencia-document-10-alpha";
import { argv } from "process";
import { client } from "./util/client";

let DELETE_INDEX = argv.includes("--delete");

let HELP = argv.includes("--help");


if( HELP ){
    process.stdout.write(`Create ${JurisprudenciaVersion10} index.\n`)
    process.stdout.write(`Use ES_URL, ES_USER and ES_PASS environment variables to setup the elasticsearch client\n`)
    process.stdout.write(`Options:\n`)
    process.stdout.write(`\t--delete\tdeletes the old index if it exists\n`)
    process.stdout.write(`\t--help\t\tshow this help\n`)

    process.exit(0)
}

client.indices.exists({index: JurisprudenciaVersion10}).then( async exists => {
    if(exists && !DELETE_INDEX){
        process.stdout.write(`Index "${JurisprudenciaVersion10}" already exists.\n`)
        let stats = await client.indices.stats({index: JurisprudenciaVersion10});
        process.stdout.write(`Status:    \t${stats.indices ? stats.indices[JurisprudenciaVersion10].health : "n.a."}\n`)
        process.stdout.write(`Total docs:\t${stats.indices ? stats.indices[JurisprudenciaVersion10].total?.docs?.count : "n.a."}\n`)
        return;
    }
    if( exists && DELETE_INDEX ){
        process.stdout.write(`Deleting current indice "${JurisprudenciaVersion10}".\n`)
        let r = await client.indices.delete({index: JurisprudenciaVersion10});
        process.stdout.write(`Result:    \t${r.acknowledged}\n`);
    }
    let r = await client.indices.create({
        index: JurisprudenciaVersion10,
        mappings: {
            dynamic_date_formats: ['dd/MM/yyyy'],
            properties: JurisprudenciaDocumentProperties10 as Record<string, MappingProperty>
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
})
