import { JurisprudenciaDocument, PartialJurisprudenciaDocument, JurisprudenciaVersion, JurisprudenciaDocumentKey, GenericField, JurisprudenciaDocumentGenericKeys } from "jurisprudencia-document-11-with-tipo";
import { client } from "../util/client";
import { BulkUpdate } from "../util/bulk";
import { JSDOM } from "jsdom";

function keyToOriginal(key: JurisprudenciaDocumentKey){
    let keyToOriginalMap: Record<JurisprudenciaDocumentKey, string[] | string | null> = {
        "Relator Nome Completo": "Relator",
        "Relator Nome Profissional": "Relator",
        "Descritores": "Descritores",
        "Meio Processual": "Meio Processual",
        "Votação": "Votação",
        "Secção": "Nº Convencional",
        "Área": null,
        "Decisão": "Decisão",
        "Tribunal de Recurso": "Tribunal Recurso",
        "Tribunal de Recurso - Processo": "Processo no Tribunal Recurso",
        "Área Temática": "Área Temática",
        "Jurisprudência Estrangeira": "Jurisprudência Estrangeira",
        "Jurisprudência Internacional": "Jurisprudência Internacional",
        "Jurisprudência Nacional": "Jurisprudência Nacional",
        "Doutrina": "Doutrina",
        "Legislação Comunitária": "Legislação Comunitária",
        "Legislação Estrangeira": "Legislação Estrangeira",
        "Legislação Nacional": "Legislação Nacional",
        "Referências Internacionais": "Referências Internacionais",
        "Referência de publicação": "Referência de publicação",
        "Indicações Eventuais": "Indicações Eventuais",
        "CONTENT": null,
        "HASH": null,
        "Data": ["Data do Acordão", "Data", "Data da Decisão Sumária", "Data da Decisão Singular", "Data da Reclamação", "Data de decisão sumária", "dataAcordao"],
        "ECLI": null,
        "Original": null,
        "Número de Processo": "Processo",
        "Sumário": "Sumário",
        "Texto": "Decisão Texto Integral",
        "Fonte": null,
        "URL": null,
        "UUID": null,
        "Tipo": null,
        "Jurisprudência": null
    }
    return keyToOriginalMap[key];
}

client.indices.exists({
    index: JurisprudenciaVersion
}).then(async exists => {
    if(!exists) throw new Error(`Indice: "${JurisprudenciaVersion}" doesn't exist`);

    let bup = new BulkUpdate<JurisprudenciaDocument>(client, JurisprudenciaVersion);

    let r = await client.search<JurisprudenciaDocument>({
        index: JurisprudenciaVersion,
        scroll: "1m"
    });

    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            if( !hit._source ) continue;
            let update: PartialJurisprudenciaDocument = {};
            for( let key of JurisprudenciaDocumentGenericKeys ){
                let v = hit._source[key];
                if(!v) continue;
                if(!hit._source.Original) continue;
                let oKey = keyToOriginal(key);
                if(!oKey) continue;
                let oValue = []
                if( typeof oKey === "string" ){
                    oValue = new JSDOM(hit._source.Original[oKey]).window.document.body.textContent?.split("\n").map(t => t.trim()).filter(t => t.length > 0) || [];
                }
                else{
                    oValue = oKey.map(k => new JSDOM(hit._source!.Original![k]).window.document.body.textContent?.trim() || "");
                }
                
                update[key] = {
                    Original: oValue,
                    Index: v.Index,
                    Show: v.Show
                }
            }
            await bup.update(hit._id, update)
        }
        r = await client.scroll({scroll: "2m", scroll_id: r._scroll_id});
    }

    await bup.close()

});