import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { validateGs1CompanyPrefixRegistry, type Gs1CompanyPrefixRegistry } from "@event-pos/contracts";

export async function loadGs1CompanyPrefixRegistry(configDirectory: string): Promise<Gs1CompanyPrefixRegistry> {
  const path = join(configDirectory, "gs1-company-prefixes-jp.yaml");
  const source = await readFile(path, "utf8");
  return validateGs1CompanyPrefixRegistry(parse(source));
}
