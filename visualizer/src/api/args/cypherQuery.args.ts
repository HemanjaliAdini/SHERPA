import type BaseArgs from './base.args'

export interface CypherQueryArgs extends BaseArgs {
  graph: string
  query: string
  /** TuringDB change (branch) id to run the query against; omit for main. */
  change?: string
  /** TuringDB commit hash to run a read-only query against; omit for HEAD. */
  commit?: string
}
