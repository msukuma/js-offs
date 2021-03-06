'use strict'
const blocker = require('block-stream2')
const Writable = require('readable-stream').Writable;
const BlockCache = require('./block-cache')
const Descriptor = require('./descriptor')
const config = require('./config')
const Block = require('./block')
const util = require('./utility')
const bs58 = require('bs58')
const through = require('through2')
const isStream = require('isstream')
const streamifier = require('streamifier')
const OffUrl = require('./off-url')
const _blockSize = new WeakMap()
let _blockCache = new WeakMap()
let _hasher = new WeakMap()
let _descriptor = new WeakMap()
let _accumulator = new WeakMap()
let _url = new WeakMap()
let _size = new WeakMap()
let _count = new WeakMap()
let _randomList = new WeakMap()
let _writer = new WeakMap()

module.exports = class WritableOffStream extends Writable {
  constructor (blockSize, opts) {
    if (!Number.isInteger(blockSize)) {
      throw new Error('Block size must be an integer')
    }
    if (!opts) {
      throw new Error('Invalid Options')
    }
    if (opts instanceof BlockCache) {
      opts = { bc: opts }
    }
    if (!opts.bc) {
      throw new Error('Invalid Block Cache')
    }
    opts.highWaterMark = blockSize
    super(opts)
    if (opts.url && (opts.url instanceof OffUrl)) {
      _url.set(this, opts.url)
    } else {
      opts.url = new OffUrl
      _url.set(this, opts.url)
    }

    _blockSize.set(this, blockSize)
    _blockCache.set(this, opts.bc)
    _descriptor.set(this, new Descriptor(blockSize, opts.url.streamLength))
    _accumulator.set(this, new Buffer(0))
    _hasher.set(this, util.hasher())
    _size.set(this, 0)
    _count.set(this, 0)

    // this is the private function that does all the work of writing a block
    let writer = (buf, enc, nxt) => {
      //hash the original data
      let hasher = _hasher.get(this)
      hasher.update(buf)
      _hasher.set(this, hasher)

      let bc = _blockCache.get(this)
      let randomList = _randomList.get(this)
      let url = _url.get(this)
      let randoms = []

      //gather the randoms from the cache
      let gather = () => {
        let i = -1
        let randomList = _randomList.get(this)
        let next = (err, block) => {
          if (err) {
            return this.emit('error', err)
          }
          if (block) {
            randoms.push(block)
          }
          i++
          if (i < (config.tupleSize - 1)) {
            let random = randomList.shift()
            if (random) {
              bc.get(random, next)
            } else {
              bc.randomBlock(next)
            }
          } else {
            return process()
          }
        }
        next()
      }

      //process the randoms into a tuple
      let process = () => {
        //create off block from accumulated buffer
        let count = _count.get(this)
        let offBlock = new Block(buf, blockSize)
        if (count === 0) {
          url.hash = offBlock.key
          _url.set(this, url)
        }

        let descriptor = _descriptor.get(this)
        let tuple = []
        for (let i = 0; i < randoms.length; i++) {
          offBlock = offBlock.parity(randoms[ i ])
          tuple.push(randoms[ i ])
        }
        // Save the first three off blocks as part of the url
        if (count < 3) {
          let url = _url.get(this)
          url[ 'tupleBlock' + (count + 1) ] = offBlock.key
          _url.set(this, url)
        }
        // TODO: Count may not be neccessary
        count++
        _count.set(this, count)

        tuple.unshift(offBlock)
        descriptor.tuple(tuple)
        _descriptor.set(this, descriptor)

        //save resultant off block
        bc.put(offBlock, (err)=> {
          if (err) {
            this.emit('error', err)
            return
          }
          return nxt()
        })
        //Save block to network
        bc.emit('block', offBlock)
      }
      //Get the keys of all the randoms needed for writing this file's representations
      if (!randomList) {
        bc.randomBlockList((Math.ceil(url.streamLength / blockSize) * (config.tupleSize - 1)), (err, randoms) => {
          if (err) {
            return this.emit('error', err)
          }
          randomList = randoms
          _randomList.set(this, randomList)
          gather()
        })
      } else {
        gather()
      }

    }
    _writer.set(this, writer)

    // This is the finish event that closes out the stream and produces the final url
    this.on('finish', () => {
      let accumulator = _accumulator.get(this)
      let bc = _blockCache.get(this)

      //callback to help close out the stream with a url
      // Store each descriptor block
      let genURL = () => {
        let descriptor = _descriptor.get(this)
        let dBlocks = descriptor.blocks()
        let i = -1
        let next = (err) => {
          if (err) {
            this.emit('error', err)
            return
          }
          i++
          if (i < dBlocks.length) {
            let block = dBlocks[ i ]
            bc.put(block, (err) => {
              if (err) {
                return next(err)
              }
              return next(err)
            })
            //Save block to network
            bc.emit('block', block)
          } else {
            let hasher = _hasher.get(this)
            let url = _url.get(this)
            let size = _size.get(this)
            url.fileHash = bs58.encode(hasher.digest())
            url.descriptorHash = dBlocks[ 0 ].key
            url.streamLength = size
            url.streamOffsetLength = size
            url.streamOffset = 0
            _url.set(this, url)
            this.emit('url', url)
            return
          }
        }
        next()
      }
      if (accumulator.length > 0) {
        let bufStream

        bufStream = streamifier.createReadStream(accumulator)

        if (!isStream.isReadable(bufStream)) {
          this.emit('error', new Error('Invalid Input'))
          return
        }

        //Start Chunking and processing chunks into blocks
        bufStream.pipe(blocker({ size: blockSize, zeroPadding: false }))
          .pipe(through(writer))
          .on('finish', genURL)
      } else {
        genURL()
      }
    })
  }

  _write (buf, enc, nxt) {
    // we need to accumulate when the bufs are tiny
    let blockSize = _blockSize.get(this)
    let accumulator = _accumulator.get(this)
    let size = _size.get(this)
    size += buf.length
    _size.set(this, size)

    accumulator = Buffer.concat([ accumulator, buf ])
    _accumulator.set(this, accumulator)
    if (accumulator.length < blockSize) {
      return nxt()
    } else {
      let writer = _writer.get(this)
      //Break off a chunk from the accumulated data
      let buf = accumulator.slice(0, blockSize)
      accumulator = accumulator.slice(blockSize)
      _accumulator.set(this, accumulator)
      writer(buf, enc, nxt)
    }
  }

}