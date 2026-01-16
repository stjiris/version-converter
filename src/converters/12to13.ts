import { JurisprudenciaVersion as JurisprudenciaVersion12 } from "jurisprudencia-document-12"
import { JurisprudenciaVersion as JurisprudenciaVersion13 } from "jurisprudencia-document-13"
import { client } from "../util/client"
import { waitTask } from "../util/wait-task";

Promise.all([
    client.indices.exists({ index: JurisprudenciaVersion12 }).catch(() => false),
    client.indices.exists({ index: JurisprudenciaVersion13 }).catch(() => false)
]).then(async ([existsV12, existsV13]) => {
    if (!existsV12 || !existsV13) throw new Error(`All indexes must exist. (${JurisprudenciaVersion12}: ${existsV12}, ${JurisprudenciaVersion13}: ${existsV13})`);

    let { task: taskId } = await client.reindex({
        source: { index: JurisprudenciaVersion12 },
        dest: { index: JurisprudenciaVersion13 },
        wait_for_completion: false
    });

    // log progress of reindex
    await waitTask(taskId as string, (task) => {
        let { created, updated, deleted, total } = task.task.status!;
        let sum = created + updated + deleted
        console.log(`${sum} / ${total} (${Math.floor(1000 * sum / total) / 10}%)`)
    }, 7.5);
}).catch(e => console.error(e))