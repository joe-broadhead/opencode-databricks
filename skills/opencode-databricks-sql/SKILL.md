---
name: opencode-databricks-sql
description: The Databricks SQL dialect as this plugin's read path will accept it - three-level names, :name parameters and what needs a plan. An outline until the tools exist.
---
If Databricks' tools are absent, run `/connect` and choose Databricks, or on Jelly call jelly_connection_request.

# Databricks SQL

This version has no tools yet. Reads will name tables fully (`catalog.schema.table`), pass values as `:name` markers,
and call only built-in functions; anything else will need a plan.
