import { register } from 'node:module'

register(new URL('./tsx-loader.mjs', import.meta.url).href, { parentURL: import.meta.url })
