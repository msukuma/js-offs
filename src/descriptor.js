'use strict'
const Block = require('./block')
const config = require('./config')
let _data = new WeakMap()
let _blockArr = new WeakMap()
let _max = new WeakMap()
let _cutPoint = new WeakMap()
let _tuppleBytes = new WeakMap()
let _blockSize = new WeakMap()

module.exports = class Descriptor {
  constructor (blockSize, streamLength) {
    if (!Number.isInteger(blockSize)) {
      throw new Error('Block size must be an integer')
    }
    let blocks = Math.ceil(streamLength / blockSize) //total number of source blocks
    let cutPoint = ((Math.floor(blockSize / config.descriptorPad) ) * config.descriptorPad)// maximum length of a descriptor in bytes
    _cutPoint.set(this, cutPoint)
    let tuppleBytes = blocks * config.descriptorPad * config.tupleSize // total size of all tupple descriptions
    _tuppleBytes.set(this, tuppleBytes)
    _blockSize.set(this, blockSize)
    _data.set(this, new Buffer(0))
    _blockArr.set(this, [])
    _max.set(this, Math.floor(blockSize / config.descriptorPad) * config.descriptorPad)
  }

  //once blocks have been created the descriptor is sealed
  get sealed () {
    return (_blockArr.get(this).length !== 0)
  }

  //variadic function and it does expect input
  tuple (blocks) {
    if (!this.sealed) {
      if (!(Array.isArray(blocks) && blocks.length === config.tupleSize)) {
        throw new TypeError('Invalid Tuple')
      }
      let data = _data.get(this)
      for (let block of blocks) {
        //TODO Store files to keep local?
        data = Buffer.concat([ data, block.hash ])
      }
      _data.set(this, data)
      let tuppleBytes = _tuppleBytes.get(this)
      if (data.length > tuppleBytes) {
        throw new Error('Descriptor is too large for the stream length')
      }
    } else {
      throw new Error('Descriptor has been sealed')
    }
  }

  blocks () {
    let blockArr = _blockArr.get(this)
    let blockSize = _blockSize.get(this)
    let tuppleBytes = _tuppleBytes.get(this)
    let data = _data.get(this)
    let cutPoint = _cutPoint.get(this)
    if (blockArr.length === 0) {
      if (tuppleBytes !== data.length) {
        throw new Error('descriptor size is invalid')
      }
      let descBlocks = []
      while (data.length > cutPoint) {
        //cut out a descriptor block with spaces for the next blocks hash
        let divider = cutPoint - config.descriptorPad
        let desc = data.slice(0, divider)
        data = data.slice(divider, data.length)
        descBlocks.push(desc)
      }
      if (data.length) {
        descBlocks.push(data)
      }
      let prior
      for (let i = (descBlocks.length - 1); i >= 0; i--) {
        if (prior) {
          descBlocks[ i ] = Buffer.concat([ descBlocks[ i ], prior ])
          prior = null
        }
        let descBlock = new Block(descBlocks[ i ], blockSize)
        //TODO Store files to keep local?
        prior = descBlock.hash
        let lasthash = descBlock.data.slice(0, cutPoint).slice((cutPoint - config.descriptorPad), cutPoint)
        blockArr.unshift(descBlock)
      }
      return blockArr
    } else {
      return blockArr
    }
  }
}