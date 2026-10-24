#!/usr/bin/env node

import { Context } from '@ruobai/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@ruobai/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@ruobai/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
