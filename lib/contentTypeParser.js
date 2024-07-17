'use strict'

let lru = require('tiny-lru')
// Needed to handle Webpack and faux modules
// See https://github.com/fastify/fastify/issues/2356
// and https://github.com/fastify/fastify/discussions/2907.
lru = typeof lru === 'function' ? lru : lru.default

const secureJson = require('secure-json-parse')
const {
  kDefaultJsonParse,
  kContentTypeParser,
  kBodyLimit,
  kRequestPayloadStream,
  kState,
  kTestInternals
} = require('./symbols')

const {
  FST_ERR_CTP_INVALID_TYPE,
  FST_ERR_CTP_EMPTY_TYPE,
  FST_ERR_CTP_ALREADY_PRESENT,
  FST_ERR_CTP_INVALID_HANDLER,
  FST_ERR_CTP_INVALID_PARSE_TYPE,
  FST_ERR_CTP_BODY_TOO_LARGE,
  FST_ERR_CTP_INVALID_MEDIA_TYPE,
  FST_ERR_CTP_INVALID_CONTENT_LENGTH,
  FST_ERR_CTP_EMPTY_JSON_BODY,
  FST_ERR_CTP_INSTANCE_ALREADY_STARTED
} = require('./errors')
const warning = require('./warnings')

function ContentTypeParser (bodyLimit, onProtoPoisoning, onConstructorPoisoning) {
  this[kDefaultJsonParse] = getDefaultJsonParser(onProtoPoisoning, onConstructorPoisoning)
  this.customParsers = {}
  this.customParsers['application/json'] = new Parser(true, false, bodyLimit, this[kDefaultJsonParse])
  this.customParsers['text/plain'] = new Parser(true, false, bodyLimit, defaultPlainTextParser)
  this.parserList = [new ParserListItem('application/json'), new ParserListItem('text/plain')]
  this.parserRegExpList = []
  this.cache = lru(100)
}

ContentTypeParser.prototype.add = function (contentType, opts, parserFn) {
  const contentTypeIsString = typeof contentType === 'string'

  if (!contentTypeIsString && !(contentType instanceof RegExp)) throw new FST_ERR_CTP_INVALID_TYPE()
  if (contentTypeIsString && contentType.length === 0) throw new FST_ERR_CTP_EMPTY_TYPE()
  if (typeof parserFn !== 'function') throw new FST_ERR_CTP_INVALID_HANDLER()

  if (this.existingParser(contentType)) {
    throw new FST_ERR_CTP_ALREADY_PRESENT(contentType)
  }

  if (opts.parseAs !== undefined) {
    if (opts.parseAs !== 'string' && opts.parseAs !== 'buffer') {
      throw new FST_ERR_CTP_INVALID_PARSE_TYPE(opts.parseAs)
    }
  }

  const parser = new Parser(
    opts.parseAs === 'string',
    opts.parseAs === 'buffer',
    opts.bodyLimit,
    parserFn
  )

  if (contentTypeIsString && contentType === '*') {
    this.customParsers[''] = parser
  } else {
    if (contentTypeIsString) {
      if (contentType !== 'application/json' && contentType !== 'text/plain') {
        this.parserList.unshift(new ParserListItem(contentType))
      }
    } else {
      this.parserRegExpList.unshift(contentType)
    }
    this.customParsers[contentType] = parser
  }
}

ContentTypeParser.prototype.hasParser = function (contentType) {
  return contentType in this.customParsers
}

ContentTypeParser.prototype.existingParser = function (contentType) {
  if (contentType === 'application/json' && contentType in this.customParsers) {
    return this.customParsers['application/json'].fn !== this[kDefaultJsonParse]
  }
  if (contentType === 'text/plain' && contentType in this.customParsers) {
    return this.customParsers['text/plain'].fn !== defaultPlainTextParser
  }

  return contentType in this.customParsers
}

ContentTypeParser.prototype.getParser = function (contentType) {
  const parser = this.cache.get(contentType)
  // TODO not covered by tests, this is a security backport
  /* istanbul ignore next */
  if (parser !== undefined) return parser

  const parsed = safeParseContentType(contentType)

  // dummyContentType always the same object
  // we can use === for the comparsion and return early
  if (parsed === dummyContentType) {
    return this.customParsers[''] || null
  }

  // eslint-disable-next-line no-var
  for (var i = 0; i !== this.parserList.length; ++i) {
    const parserListItem = this.parserList[i]
    if (compareContentType(parsed, parserListItem)) {
      const parser = this.customParsers[parserListItem.name] || null
      // we set request content-type in cache to reduce parsing of MIME type
      this.cache.set(contentType, parser)
      return parser
    }
  }

  // eslint-disable-next-line no-var
  for (var j = 0; j !== this.parserRegExpList.length; ++j) {
    const parserRegExp = this.parserRegExpList[j]
    if (compareRegExpContentType(contentType, parsed.type, parserRegExp)) {
      const parser = this.customParsers[parserRegExp]
      this.cache.set(contentType, parser)
      return parser
    }
  }

  return this.customParsers['']
}

ContentTypeParser.prototype.run = function (contentType, handler, request, reply) {
  const parser = this.cache.get(contentType) || this.getParser(contentType)

  if (parser === undefined || parser === null) {
    reply.send(new FST_ERR_CTP_INVALID_MEDIA_TYPE(contentType))
  } else if (parser.asString === true || parser.asBuffer === true) {
    rawBody(
      request,
      reply,
      reply.context._parserOptions,
      parser,
      done
    )
  } else {
    let result

    if (parser.isDeprecatedSignature) {
      result = parser.fn(request[kRequestPayloadStream], done)
    } else {
      result = parser.fn(request, request[kRequestPayloadStream], done)
    }

    if (result && typeof result.then === 'function') {
      result.then(body => done(null, body), done)
    }
  }

  function done (error, body) {
    if (error) {
      reply.send(error)
    } else {
      request.body = body
      handler(request, reply)
    }
  }
}

function rawBody (request, reply, options, parser, done) {
  const asString = parser.asString
  const limit = options.limit === null ? parser.bodyLimit : options.limit
  const contentLength = request.headers['content-length'] === undefined
    ? NaN
    : Number.parseInt(request.headers['content-length'], 10)

  if (contentLength > limit) {
    reply.send(new FST_ERR_CTP_BODY_TOO_LARGE())
    return
  }

  let receivedLength = 0
  let body = asString === true ? '' : []

  const payload = request[kRequestPayloadStream] || request.raw

  if (asString === true) {
    payload.setEncoding('utf8')
  }

  payload.on('data', onData)
  payload.on('end', onEnd)
  payload.on('error', onEnd)
  payload.resume()

  function onData (chunk) {
    receivedLength += chunk.length

    if ((payload.receivedEncodedLength || receivedLength) > limit) {
      payload.removeListener('data', onData)
      payload.removeListener('end', onEnd)
      payload.removeListener('error', onEnd)
      reply.send(new FST_ERR_CTP_BODY_TOO_LARGE())
      return
    }

    if (asString === true) {
      body += chunk
    } else {
      body.push(chunk)
    }
  }

  function onEnd (err) {
    payload.removeListener('data', onData)
    payload.removeListener('end', onEnd)
    payload.removeListener('error', onEnd)

    if (err !== undefined) {
      err.statusCode = 400
      reply.code(err.statusCode).send(err)
      return
    }

    if (asString === true) {
      receivedLength = Buffer.byteLength(body)
    }

    if (!Number.isNaN(contentLength) && (payload.receivedEncodedLength || receivedLength) !== contentLength) {
      reply.send(new FST_ERR_CTP_INVALID_CONTENT_LENGTH())
      return
    }

    if (asString === false) {
      body = Buffer.concat(body)
    }

    const result = parser.fn(request, body, done)
    if (result && typeof result.then === 'function') {
      result.then(body => done(null, body), done)
    }
  }
}

function getDefaultJsonParser (onProtoPoisoning, onConstructorPoisoning) {
  return defaultJsonParser

  function defaultJsonParser (req, body, done) {
    if (body === '' || body == null) {
      return done(new FST_ERR_CTP_EMPTY_JSON_BODY(), undefined)
    }
    let json
    try {
      json = secureJson.parse(body, { protoAction: onProtoPoisoning, constructorAction: onConstructorPoisoning })
    } catch (err) {
      err.statusCode = 400
      return done(err, undefined)
    }
    done(null, json)
  }
}

function defaultPlainTextParser (req, body, done) {
  done(null, body)
}

function Parser (asString, asBuffer, bodyLimit, fn) {
  this.asString = asString
  this.asBuffer = asBuffer
  this.bodyLimit = bodyLimit
  this.fn = fn

  // Check for deprecation syntax
  if (fn.length === (fn.constructor.name === 'AsyncFunction' ? 1 : 2)) {
    warning.emit('FSTDEP003')
    this.isDeprecatedSignature = true
  }
}

function buildContentTypeParser (c) {
  const contentTypeParser = new ContentTypeParser()
  contentTypeParser[kDefaultJsonParse] = c[kDefaultJsonParse]
  Object.assign(contentTypeParser.customParsers, c.customParsers)
  contentTypeParser.parserList = c.parserList.slice()
  return contentTypeParser
}

function addContentTypeParser (contentType, opts, parser) {
  if (this[kState].started) {
    throw new Error('Cannot call "addContentTypeParser" when fastify instance is already started!')
  }

  if (typeof opts === 'function') {
    parser = opts
    opts = {}
  }

  if (!opts) opts = {}
  if (!opts.bodyLimit) opts.bodyLimit = this[kBodyLimit]

  if (Array.isArray(contentType)) {
    contentType.forEach((type) => this[kContentTypeParser].add(type, opts, parser))
  } else {
    this[kContentTypeParser].add(contentType, opts, parser)
  }

  return this
}

ContentTypeParser.prototype.removeAll = function () {
  this.customParsers = {}
  this.parserRegExpList = []
  this.parserList = []
  this.cache = lru(100)
}

function hasContentTypeParser (contentType) {
  return this[kContentTypeParser].hasParser(contentType)
}

const PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g // eslint-disable-line no-control-regex
const TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g // eslint-disable-line no-control-regex

function ContentType (type) {
  this.parameters = Object.create(null)
  this.type = type
}

// dummy here to prevent repeated object creation
const dummyContentType = { type: '', parameters: Object.create(null) }

function getcontenttype (obj) {
  // eslint-disable-next-line no-var
  var header

  if (typeof obj.getHeader === 'function') {
    // res-like
    header = obj.getHeader('content-type')
  } else if (typeof obj.headers === 'object') {
    // req-like
    header = obj.headers && obj.headers['content-type']
  }

  if (typeof header !== 'string') {
    throw new TypeError('content-type header is missing from object')
  }

  return header
}

function safeParseContentType (string) {
  try {
    if (!string) {
      throw new TypeError('argument string is required')
    }

    // support req/res-like objects as argument
    // eslint-disable-next-line no-var
    var header = typeof string === 'object'
      ? getcontenttype(string)
      : string

    if (typeof header !== 'string') {
      throw new TypeError('argument string is required to be a string')
    }

    // eslint-disable-next-line no-var
    var index = header.indexOf(';')
    // eslint-disable-next-line no-var
    var type = index !== -1
      ? header.slice(0, index).trim()
      : header.trim()

    if (!TYPE_REGEXP.test(type)) {
      throw new TypeError('invalid media type')
    }

    // eslint-disable-next-line no-var
    var obj = new ContentType(type.toLowerCase())

    // parse parameters
    if (index !== -1) {
      // eslint-disable-next-line no-var
      var key
      // eslint-disable-next-line no-var
      var match
      // eslint-disable-next-line no-var
      var value

      PARAM_REGEXP.lastIndex = index

      while ((match = PARAM_REGEXP.exec(header))) {
        if (match.index !== index) {
          throw new TypeError('invalid parameter format')
        }

        index += match[0].length
        key = match[1].toLowerCase()
        value = match[2]

        if (value.charCodeAt(0) === 0x22 /* " */) {
          // remove quotes
          value = value.slice(1, -1)

          // remove escapes
          if (value.indexOf('\\') !== -1) {
            value = value.replace(QESC_REGEXP, '$1')
          }
        }

        obj.parameters[key] = value
      }

      if (index !== header.length) {
        throw new TypeError('invalid parameter format')
      }
    }

    return obj
  } catch (err) {
    return dummyContentType
  }
}

function compareContentType (contentType, parserListItem) {
  if (parserListItem.isEssence) {
    // we do essence check
    return contentType.type.indexOf(parserListItem) !== -1
  } else {
    // when the content-type includes parameters
    // we do a full-text search
    // reject essence content-type before checking parameters
    if (contentType.type.indexOf(parserListItem.type) === -1) return false
    for (const key of parserListItem.parameterKeys) {
      // reject when missing parameters
      if (!(key in contentType.parameters)) return false
      // reject when parameters do not match
      if (contentType.parameters[key] !== parserListItem.parameters[key]) return false
    }
    return true
  }
}

function compareRegExpContentType (contentType, essenceMIMEType, regexp) {
  if (regexp.source.indexOf(';') === -1) {
    // we do essence check
    return regexp.test(essenceMIMEType)
  } else {
    // when the content-type includes parameters
    // we do a full-text match
    return regexp.test(contentType)
  }
}

function ParserListItem (contentType) {
  this.name = contentType
  // we pre-calculate all the needed information
  // before content-type comparsion
  const parsed = safeParseContentType(contentType)
  this.type = parsed.type
  this.parameters = parsed.parameters
  this.parameterKeys = Object.keys(parsed.parameters)
  this.isEssence = contentType.indexOf(';') === -1
}

// used in ContentTypeParser.remove
ParserListItem.prototype.toString = function () {
  return this.name
}

function removeAllContentTypeParsers () {
  if (this[kState].started) {
    throw new FST_ERR_CTP_INSTANCE_ALREADY_STARTED('removeAllContentTypeParsers')
  }

  this[kContentTypeParser].removeAll()
}

module.exports = ContentTypeParser
module.exports.helpers = {
  buildContentTypeParser,
  addContentTypeParser,
  hasContentTypeParser,
  removeAllContentTypeParsers
}
module.exports.defaultParsers = {
  getDefaultJsonParser,
  defaultTextParser: defaultPlainTextParser
}
module.exports[kTestInternals] = { rawBody }
