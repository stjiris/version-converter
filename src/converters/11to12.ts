import { JurisprudenciaVersion as JurisprudenciaVersion11WithTipo } from "jurisprudencia-document-11-with-tipo"
import { JurisprudenciaVersion as JurisprudenciaVersion12 } from "jurisprudencia-document-12"
import { client } from "../util/client"
import { waitTask } from "../util/wait-task";

Promise.all([
    client.indices.exists({index: JurisprudenciaVersion11WithTipo}).catch(e => false),
    client.indices.exists({index: JurisprudenciaVersion12}).catch(e => false)
]).then(async ([existsV11,existsV12]) => {
    if( !existsV11 || !existsV12 ) throw new Error(`All indexes must exist. (${JurisprudenciaVersion11WithTipo}: ${existsV11}, ${JurisprudenciaVersion12}: ${existsV12})`);
    // Add state field with active string
    let {task: taskId} = await client.reindex({
        source: {index: JurisprudenciaVersion11WithTipo},
        dest: {index: JurisprudenciaVersion12},
        script: {
            source: `
                ctx._source.STATE = "active";
            `
        },
        wait_for_completion: false
    });

    // log progress of reindex
    await waitTask(taskId as string, (task) => {
        let {created, updated, deleted, total} = task.task.status!;
        let sum = created+updated+deleted
        console.log(`${sum} / ${total} (${Math.floor(1000*sum / total)/10}%)`) 
    }, 7.5);
}).catch(e => console.error(e))