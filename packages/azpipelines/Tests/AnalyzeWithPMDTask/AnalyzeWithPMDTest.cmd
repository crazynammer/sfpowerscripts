

SET INPUT_DIRECTORY=..\..\..\..\tests\force-di
SET INPUT_RULESET=sfpowerkit
SET INPUT_FORMAT=text
SET INPUT_VERSION=6.21.0
SET INPUT_ISTOBREAKBUILD=false

SET INPUT_ISTELEMETRYENABLED=false



ts-node ..\..\BuildTasks\AnalyzeWithPMDTask\AnalyzeWithPMD.ts
