import { JurisprudenciaDocument as JurisprudenciaDocument10, JurisprudenciaVersion as JurisprudenciaVersion10  } from "jurisprudencia-document-10-alpha";
import { JurisprudenciaDocument as JurisprudenciaDocument11, JurisprudenciaVersion as JurisprudenciaVersion11  } from "jurisprudencia-document-11";
import { BulkUpdate } from "../util/bulk";
import { client } from "../util/client";

Promise.all([
    client.indices.exists({index: JurisprudenciaVersion10}).catch(e => false),
    client.indices.exists({index: JurisprudenciaVersion11}).catch(e => false)
]).then(async ([existsV10,existsV11]) => {
    if( !existsV10 || !existsV11 ) throw new Error(`All indexes must exist. (${JurisprudenciaVersion10}: ${existsV10}, ${JurisprudenciaVersion11}: ${existsV11})`)

    let bulk = new BulkUpdate(client, JurisprudenciaVersion11);

    let r = await client.search<JurisprudenciaDocument10>({
        index: JurisprudenciaVersion10,
        scroll: '1m',
        query: { match_all: {} },
        _source: "*" 
    });
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            let {"Votação - Decisão": votDci, "Votação - Vencidos": votVen, "Votação - Declarações": votDcl, "Decisão (textual)": decTex,...oldDoc} = hit._source!;
            let newDoc: JurisprudenciaDocument11 = {
                ...oldDoc,
                Votação: {
                    Index: [...(votDci?.Index || []), ...(votVen?.Index || []), ...(votDcl?.Index || [])],
                    Original: [...(votDci?.Original || []), ...(votVen?.Original || []), ...(votDcl?.Original || [])],
                    Show: [...(votDci?.Show || []), ...(votVen?.Show || []), ...(votDcl?.Show || [])],
                }
            }
            await bulk.create(hit._id, newDoc);
        }
        r = await client.scroll({scroll: "1m", scroll_id: r._scroll_id})
    }
    await bulk.close()
}).catch(e => console.error(e))
