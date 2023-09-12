import { JurisprudenciaDocument as JurisprudenciaDocument11, JurisprudenciaVersion as JurisprudenciaVersion11  } from "jurisprudencia-document-11";
import { JurisprudenciaDocument as JurisprudenciaDocument11WithTipo, JurisprudenciaVersion as JurisprudenciaVersion11WithTipo  } from "jurisprudencia-document-11-with-tipo";
import { BulkUpdate } from "../util/bulk";
import { client } from "../util/client";
import { JurisprudenciaVersion } from "jurisprudencia-document-11";
import { resolve } from "path";

Promise.all([
    client.indices.exists({index: JurisprudenciaVersion11}).catch(e => false),
    client.indices.exists({index: JurisprudenciaVersion11WithTipo}).catch(e => false)
]).then(async ([existsV11,existsV11WithTipo]) => {
    if( !existsV11 || !existsV11WithTipo ) throw new Error(`All indexes must exist. (${JurisprudenciaVersion11}: ${existsV11}, ${JurisprudenciaVersion11WithTipo}: ${existsV11WithTipo})`)
    /*
    let r = await client.search<JurisprudenciaDocument11>({
        index: JurisprudenciaVersion,
        scroll: "1m",
        _source: ["Original"]
    });
    let datas = {} as Record<string, number>;
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits){
            let dts = [];
            for(let key in hit._source?.Original){
                if( key.toLowerCase().startsWith("data") ){
                    dts.push(key)
                }
            }
            let dkey = dts.join("+");
            if( !(dkey in datas) ){
                datas[dkey] = 0
            }
            datas[dkey]++;
        }
        console.log(datas)
        r = await client.scroll({scroll: "1m", scroll_id: r._scroll_id});
    }
    console.log(datas)
    */
    // {
    //     'Data do Acordão+Data': 26403,
    //     'Data do Acordão': 39218,
    //     dataAcordao: 56,
    //     'Data da Decisão Sumária': 87,
    //     'Data de decisão sumária': 22,
    //     'Data do Acordão+Data da Decisão Sumária': 4,
    //     'Data do Acordão+Data da Decisão Singular': 2,
    //     'Data da Reclamação': 6,
    //     'Data do Acordão+Data de decisão sumária': 1,
    //     Data: 2
    // }
    let {task: taskId} = await client.reindex({
        source: {index: JurisprudenciaVersion11},
        dest: {index: JurisprudenciaVersion11WithTipo},
        script: {
            source: `
                def decSuma = ctx['_source']['Original'].containsKey("Data da Decisão Sumária") || ctx['_source']['Original'].containsKey("Data de decisão sumária");
                def decSing = ctx['_source']['Original'].containsKey("Data da Decisão Singular");
                def reclama = ctx['_source']['Original'].containsKey("Data da Reclamação");
                ctx['_source']['Tipo'] = decSuma ? "Decisão Sumária" : decSing ? "Decisão Singular" : reclama ? "Reclamação" : "Acórdão";
            `
        },
        wait_for_completion: false
    });
    let task = await client.tasks.get({task_id: taskId! as string})
    while(!task.completed){
        let {created, updated, deleted, total} = task.task.status!;
        let sum = created+updated+deleted
        console.log(`${sum} / ${total} (${Math.floor(1000*sum / total)/10}%)`)
        await sleep(7.5);
        task = await client.tasks.get({task_id: taskId! as string})
    }
}).catch(e => console.error(e))


function sleep(s: number){
    return new Promise(resolve => {
        setTimeout(resolve, s * 1000)
    })
}