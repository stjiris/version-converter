# About 

CLI utils to convert the elasticsearch documents between different versions of [@stjiris/jurisprudencia-document](https://www.npmjs.com/package/@stjiris/jurisprudencia-document)

## Usage

Must use `tsc` to compile `src` and create the `dist` folder whit the scripts:

### Create

`$ node dist/create`

```
Usage: node dist/create [OPTIONS] <index>
Create Jurisprudencia index.
Use ES_URL, ES_USER and ES_PASS environment variables to setup the elasticsearch client
Options:
        --delete        recreates the index if it already exists [deletes the content]
        --help          show this help
Available index values:
jurisprudencia.9.4, jurisprudencia.10.0-alpha, jurisprudencia.11.0
```

### Convert

`$ node dist/convert`

```
Usage: node /Users/diogoalmiro/Documents/stjiris/version-converter/dist/convert.js <converter>
Populate index from a version to another.
Use ES_URL, ES_USER and ES_PASS environment variables to setup the elasticsearch client
Available converter values: 10to11, 9to10
```

## Versions

 - 9.4 to 10.0-alpha

Updates on the indice structure, generic fields now have a Original, Index and Show properties of string arrays. 

 - 10.0-alpha to 11.0

Joined "Votação - *" to the same field "Votação" and removed "Decisão (textual)".


