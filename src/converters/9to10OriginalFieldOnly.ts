// (temporary) File to populate 10.0-alpha with Original field
// 9to10.ts was corrected after the migration, this file should not be needed if 10.0-alpha is empty
import { JurisprudenciaDocument as JurisprudenciaDocument10, JurisprudenciaVersion as JurisprudenciaVersion10  } from "jurisprudencia-document-10-alpha";
import { ExactTypedJurisprudenciaDocument as JurisprudenciaDocument9, JurisprudenciaDocumentArrayKey, JurisprudenciaDocumentKey, JurisprudenciaVersion as JurisprudenciaVersion9 } from "jurisprudencia-document-9";
import { BulkUpdate } from "../util/bulk";
import { client } from "../util/client";

client.indices.exists({
    index: JurisprudenciaVersion10
}).then(exists => {
    if( ! exists ){
        throw new Error(`${JurisprudenciaVersion10} index must exists`)
    }
}).then(async () => {
    let bulk = new BulkUpdate<JurisprudenciaDocument10>(client, JurisprudenciaVersion10);
    let r = await client.search<JurisprudenciaDocument9>({
        index: JurisprudenciaVersion9,
        scroll: '1m',
        query: { match_all: {} },
        _source: "Original"
    });
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            let {Original} = hit._source!;
            await bulk.update(hit._id, {Original: Original});
        }
        r = await client.scroll({scroll: "1m", scroll_id: r._scroll_id})
    }
    await bulk.close()
}).catch(e => console.error(e))