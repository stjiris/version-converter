import { JurisprudenciaDocument as JurisprudenciaDocument10, JurisprudenciaVersion as JurisprudenciaVersion10  } from "jurisprudencia-document-10-alpha";
import { ExactTypedJurisprudenciaDocument as JurisprudenciaDocument9, JurisprudenciaDocumentArrayKey, JurisprudenciaDocumentKey, JurisprudenciaVersion as JurisprudenciaVersion9 } from "jurisprudencia-document-9";
import { BulkUpdate } from "./util/bulk";
import { client } from "./util/client";

function joinRemovingNoValue(array: string | string[], toRemove: string){
    return Array.isArray(array) ? array.filter( s => s !== toRemove) : array === toRemove ? [] : [array];
}

function splitOrNull(accessKey: JurisprudenciaDocumentKey, obj: Partial<JurisprudenciaDocument9>): {Original: string[], Show: string[], Index: string[]} | null {
    let value = obj[accessKey];
    if( !value ) return null;
    if( typeof value === "object" && !Array.isArray(value) ) return null; // Dont use Record<string,any>
    let cleanedValue = joinRemovingNoValue(Array.isArray(value) ? value : value.split("\n"), `«sem ${accessKey}»`);
    if( value.length === 0 || cleanedValue.length === 0 ) return null;

    return {Original: cleanedValue, Show: cleanedValue, Index: cleanedValue}
}

client.indices.exists({
    index: JurisprudenciaVersion10
}).then(exists => {
    if( ! exists ){
        throw new Error(`${JurisprudenciaVersion10} index must exists`)
    }
}).then(async () => {
    await client.indices.putSettings({
        index: JurisprudenciaVersion10,
        settings: {
            refresh_interval: -1
        }
    })
    let bulk = new BulkUpdate<JurisprudenciaDocument10>(client, JurisprudenciaVersion10);
    let r = await client.search<JurisprudenciaDocument9>({
        index: JurisprudenciaVersion9,
        scroll: '1m',
        query: { match_all: {} },
        _source: "*" 
    });
    while( r.hits.hits.length > 0 ){
        for( let hit of r.hits.hits ){
            let {Original: {"": _, Original}, CONTENT, HASH, Data, Sumário, Texto, "Número de Processo": num, ECLI, Fonte, UUID, URL, "Relator Nome Completo": relComp, "Relator Nome Profissional": relProf, Secção, Área, ...rest} = hit._source!;
            let newDocumentVersion: JurisprudenciaDocument10 = {
                Original: Original,
                CONTENT: CONTENT,
                HASH: {Original: HASH.Original, Processo: HASH.Processo, Sumário: HASH.Sumário, Texto: HASH.Sumário},
                Data: Data,
                Sumário: Sumário || null,
                Texto: Texto || null,
                "Número de Processo": num,
                "ECLI": ECLI,
                "Fonte": Fonte,
                "UUID": UUID,
                "URL": URL,
                "Secção": {Original: [Secção], Show: [Secção], Index: [Secção]},
                "Área": {Original: [Área], Show: [Área], Index: [Área]},
                "Relator Nome Completo": {Original: [relComp], Show: [relComp], Index: [relComp]},
                "Relator Nome Profissional": {Original: [relProf], Show: [relProf], Index: [relProf]},
                
                "Decisão": splitOrNull("Decisão", rest),
                "Decisão (textual)": splitOrNull("Decisão (textual)", rest),
                "Descritores": splitOrNull("Descritores", rest),
                "Doutrina": splitOrNull("Doutrina", rest),
                "Indicações Eventuais": splitOrNull("Indicações Eventuais", rest),
                "Jurisprudência": splitOrNull("Jurisprudência", rest),
                "Jurisprudência Estrangeira": splitOrNull("Jurisprudência Estrangeira", rest),
                "Jurisprudência Internacional": splitOrNull("Jurisprudência Internacional", rest),
                "Jurisprudência Nacional": splitOrNull("Jurisprudência Nacional", rest),
                "Legislação Comunitária": splitOrNull("Legislação Comunitária", rest),
                "Legislação Estrangeira": splitOrNull("Legislação Estrangeira", rest),
                "Legislação Nacional": splitOrNull("Legislação Nacional", rest),
                "Meio Processual": splitOrNull("Meio Processual", rest),
                "Referência de publicação": splitOrNull("Referência de publicação", rest),
                "Referências Internacionais": splitOrNull("Referências Internacionais", rest),
                "Tribunal de Recurso": splitOrNull("Tribunal de Recurso", rest),
                "Tribunal de Recurso - Processo": splitOrNull("Tribunal de Recurso - Processo", rest),
                "Votação - Decisão": splitOrNull("Votação - Decisão", rest),
                "Votação - Declarações": splitOrNull("Votação - Declarações", rest),
                "Votação - Vencidos": splitOrNull("Votação - Vencidos", rest),
                "Área Temática": splitOrNull("Área Temática", rest)
            }
            await bulk.create(hit._id, newDocumentVersion);
        }
        r = await client.scroll({scroll: "1m", scroll_id: r._scroll_id})
    }
    await bulk.close()
    await client.indices.putSettings({
        index: JurisprudenciaVersion10,
        settings: {
            refresh_interval: 0
        }
    })
}).catch(e => console.error(e))