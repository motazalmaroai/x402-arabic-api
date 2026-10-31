import SwaggerParser from "@apidevtools/swagger-parser";
export async function validateOpenApi(doc: any) { await SwaggerParser.validate(structuredClone(doc)); }
