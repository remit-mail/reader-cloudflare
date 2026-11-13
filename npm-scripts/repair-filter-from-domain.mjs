import { FilterRuleV1Schema, narrowFromDomainRule } from "@remit/data-ports";
import { wrangler, wranglerOutput } from "./cf.mjs";

const CANDIDATES = `SELECT filter_id, rule FROM filter WHERE rule LIKE '%"RegistrableDomain"%'`;

const literal = (value) => `'${value.replaceAll("'", "''")}'`;

const execute = (config, database, sql) => [
  "d1",
  "execute",
  database,
  "--remote",
  "--config",
  config,
  "--command",
  sql,
];

const widenedRules = (rows) =>
  rows.flatMap((row) => {
    const stored = FilterRuleV1Schema.parse(JSON.parse(row.rule));
    const rule = JSON.stringify(narrowFromDomainRule(stored));
    return rule === JSON.stringify(stored) ? [] : [{ filterId: row.filter_id, rule }];
  });

export const repairFilterFromDomain = (config, database) => {
  const [result] = JSON.parse(wranglerOutput([...execute(config, database, CANDIDATES), "--json"]));
  const widened = widenedRules(result.results);
  console.log(
    `repair: ${widened.length} filter(s) widen a subdomain FromDomain to its registrable domain`,
  );
  if (widened.length === 0) return 0;
  const updates = widened
    .map(
      ({ filterId, rule }) =>
        `UPDATE filter SET rule = ${literal(rule)} WHERE filter_id = ${literal(filterId)};`,
    )
    .join("\n");
  return wrangler(execute(config, database, updates));
};
