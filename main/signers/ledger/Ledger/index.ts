import log from 'electron-log'
import { rlp, addHexPrefix, stripHexPrefix, padToEven } from 'ethereumjs-util'

// @ts-ignore
import { v5 as uuid } from 'uuid'

import TransportNodeHid from '@ledgerhq/hw-transport-node-hid'

import { Request, RequestQueue } from './requestQueue'
import Signer, { Callback } from '../../Signer'
import LedgerEthereumApp, { Derivation } from './eth'
import { sign, signerCompatibility, londonToLegacy, AppVersion } from '../../../transaction'

const ns = '3bbcee75-cecc-5b56-8031-b6641c1ed1f1'

export const STATUS = {
  INITIAL: 'Connecting',
  OK: 'ok',
  LOADING: 'loading',
  DERIVING: 'Deriving addresses',
  LOCKED: 'Please unlock your ledger',
  WRONG_APP: 'Open your Ledger and select the Ethereum application',
  DISCONNECTED: 'Disconnected',
  NEEDS_RECONNECTION: 'Please reconnect this Ledger device'
}

interface DeviceError {
  statusCode: number,
  message: string
}

interface Address {
  address: string,
  publicKey: string,
  chainCode?: string | undefined
}

function normalizeHex (hex: string) {
  return padToEven(stripHexPrefix(hex || ''))
}

function isDeviceAsleep (err: { statusCode: number }) {
  return [27404].includes(err.statusCode)
}

function needToOpenEthApp (err: { statusCode: number }) {
  return [27904, 27906, 25873, 25871].includes(err.statusCode)
}

function getStatusForError (err: { statusCode: number }) {
  if (needToOpenEthApp(err)) {
    return STATUS.WRONG_APP
  }
  
  if (isDeviceAsleep(err)) {
    return STATUS.LOCKED
  }

  return STATUS.NEEDS_RECONNECTION
}


export default class Ledger extends Signer {
  private eth: LedgerEthereumApp | undefined;
  private devicePath: string;

  private derivation: Derivation | undefined;
  private accountLimit = 5;

  // the Ledger device can only handle one request at a time; the transport will reject
  // all incoming requests while its busy, so we need to make sure requests are only executed
  // when the device is ready
  private requestQueue = new RequestQueue()
  private statusPoller = setTimeout(() => {})

  private coinbase = '0x'

  constructor (devicePath: string) {
    super()

    this.devicePath = devicePath

    this.addresses = []

    this.id = uuid('Ledger' + this.devicePath, ns)
    this.type = 'ledger'
    this.status = STATUS.INITIAL
  }

  async open () {
    const transport = await TransportNodeHid.open(this.devicePath)

    this.eth = new LedgerEthereumApp(transport)
    this.requestQueue.start()
  }

  async close () {
    this.requestQueue.close()

    clearTimeout(this.statusPoller)

    if (this.eth) {
      await this.eth.close()
      this.eth = undefined
    }

    this.emit('close')
    this.removeAllListeners()
    
    super.close()
  }

  async connect () {
    this.updateStatus(STATUS.INITIAL)
    this.emit('update')

    try {
      // since the Ledger doesn't provide information about whether the eth app is open or if
      // the device is locked, the order of these checks is important in order to correctly determine
      // the exact status based on the returned error codes
      //  1. getAppConfiguration
      //  2. checkDeviceStatus
      //  3. deriveAddresses

      const config = await this.getAppConfiguration()

      // during connection is the only time we can access the device without
      // enqueuing the request, since no other requests should be active before
      // the device is connected
      await this.checkDeviceStatus()

      if (this.isReady()) {
        const [major, minor, patch] = (config.version || '1.6.1').split('.').map(parseInt)
        const version = { major, minor, patch }
        
        this.appVersion = version

        this.deriveAddresses()
      }
    } catch (err) {
      this.handleError(err as DeviceError)

      if (this.status !== STATUS.LOCKED) {
        this.close()
      }
    }
  }

  private isReady () {
    const readyStatuses = [STATUS.INITIAL, STATUS.OK]

    return readyStatuses.includes(this.status)
  }

  private handleError (err: DeviceError) {
    if (isDeviceAsleep(err) && this.status !== STATUS.LOCKED) {
      this.updateStatus(STATUS.LOCKED)

      this.emit('lock')
    } else {
      const errorStatus = getStatusForError(err)

      if (errorStatus !== this.status) {
        this.updateStatus(errorStatus)
        this.emit('update')

        if (this.status === STATUS.NEEDS_RECONNECTION) {
          this.close()
        }
      }
    }
  }

  updateStatus (status: string) {
    this.status = status

    if (this.status === STATUS.OK) {
      clearInterval(this.statusPoller)
      this.pollDeviceStatus(5000)
    }

    if (this.status === STATUS.LOCKED) {
      clearInterval(this.statusPoller)
      this.pollDeviceStatus(500)
    }
  }

  private async checkDeviceStatus () {
    const check = new Promise(async (resolve: (code: number) => void) => {
      setTimeout(() => resolve(-1), 3000)

      try {
        await this.eth?.getAddress("44'/60'/0'/0", false, false)
        resolve(0)
      } catch (e: any) {
        resolve(e.statusCode || -1)
      }
    })

    return check.then(statusCode => {
      if (!statusCode) {
        // success, handle different status state transitions

        if (this.status === STATUS.LOCKED) {
          // when the app is unlocked, stop checking status since we will respond
          // to this event and start checking for status when that's complete
          clearTimeout(this.statusPoller)

          this.updateStatus(STATUS.OK)
          this.emit('unlock')
        }
      } else {
        this.handleError({ statusCode, message: '' })
      }

      return statusCode
    })
  }

  private async pollDeviceStatus (frequency: number) {
    const lastStatus = this.status

    this.statusPoller = setTimeout(() => {
      const lastRequest = this.requestQueue.peekBack()

      // prevent spamming eth app checks
      if (!lastRequest || lastRequest.type !== 'checkDeviceStatus') {
        this.enqueueRequests({
          type: 'checkDeviceStatus',
          execute: async () => {
            if (lastStatus !== this.status) {
              // check if the status changed since this event was enqueued, this
              // will prevent unintended status transitions
              return true
            }

            return this.checkDeviceStatus()
          }
        })
      }

      this.pollDeviceStatus(frequency)
    }, frequency)
  }

  private enqueueRequests (...requests: Request[]) {
    requests.forEach(req => this.requestQueue.add(req))
  }

  // *** request enqueuing methods *** //

  deriveAddresses () {
    this.requestQueue.clear()
    this.addresses = []

    this.updateStatus(STATUS.DERIVING)
    this.emit('update')

    if (this.derivation === Derivation.live) {
      this.deriveLiveAddresses()
    } else {
      this.deriveHardwareAddresses()
    }
  }

  private deriveLiveAddresses () {
    const requests = []

    for (let i = 0; i < this.accountLimit; i++) {
      requests.push({
        type: 'deriveAddresses',
        execute: async () => {
          try {
            if (!this.eth)  throw new Error('attempted to derive addresses but Eth app is not connected!')
            if (!this.derivation) throw new Error('attempted to derive addresses for unknown derivation!')

            const path = this.eth.getPath(this.derivation, i)
            const { address } = await this.eth.getAddress(path, false, false)

            log.debug(`Found Ledger Live address #${i}: ${address}`)

            if (this.derivation === Derivation.live) {
              // don't update if the derivation was changed while this request was running
              if (this.status === STATUS.DERIVING) {
                this.updateStatus(STATUS.OK)
              }

              this.addresses = [...this.addresses, address]

              this.emit('update')
            }
          } catch (e) {
            this.handleError(e as DeviceError)
          }
        }
      })
    }

    this.enqueueRequests(...requests)
  }

  private deriveHardwareAddresses () {
    const targetDerivation = this.derivation

    this.enqueueRequests({
      type: 'deriveAddresses',
      execute: async () => {
        try {
          if (!this.eth)  throw new Error('attempted to derive addresses but Eth app is not connected!')
          if (!this.derivation) throw new Error('attempted to derive addresses for unknown derivation!')

          const addresses = await this.eth.deriveAddresses(this.derivation)

          if (this.derivation === targetDerivation) {
            // don't update if the derivation was changed while this request was running
            if (this.status === STATUS.DERIVING) {
              this.updateStatus(STATUS.OK)
            }

            this.addresses = [...addresses]

            this.emit('update')
          }
        } catch (e) {
          this.handleError(e as DeviceError)
        }
      }
    })
  }

  async verifyAddress (index: number, currentAddress: string, display = false, cb: Callback = () => {}) {
    this.enqueueRequests({
      type: 'verifyAddress',
      execute: async () => {
        if (!this.eth)  throw new Error('attempted to verify address but Eth app is not connected!')
        if (!this.derivation) throw new Error('attempted to verify address for unknown derivation!')

        try {
          const path = this.eth.getPath(this.derivation, index)
          const result = await this.getAddress(path, display, true)

          if (result.address.toLowerCase() !== currentAddress.toLowerCase()) {
            const err = new Error('Address does not match device')
            log.error(err)

            this.handleError({ statusCode: -1, message: '' })

            return cb(err, undefined)
          }

          log.debug('Address matches device')

          cb(null, true)
        } catch (e) {
          const err = e as DeviceError

          this.handleError(err)

          cb(new Error(`verify address error: ${err.message}`), undefined)
        }
      }
    })
  }

  // *** direct device access methods *** //

  private async getAddress (path: string, display = false, chainCode = false) {
    return new Promise((resolve: (address: Address) => void, reject) => {
      if (!this.eth) {
        return reject(new Error('tried to get address but Eth app is not connected!'))
      }

      if (!display) {
        // if display is true, the Ledger waits for user input so never time out
        setTimeout(() => reject({ message: 'getAddress timed out', statusCode: -1 }), 3000)
      }

      this.eth.getAddress(path, display, chainCode).then(resolve).catch(reject)
    })
  }

  private async getAppConfiguration () {
    // if this call blocks and we are not yet connected it means that the Ledger is locked and 
    // the eth app is not open; if the Ledger is locked and eth app IS open, this should return successfully

    return new Promise((resolve: (config: { version: string }) => void, reject) => {
      if (!this.eth) {
        return reject(new Error('tried to get app configuration but Eth app is not connected!'))
      }

      setTimeout(() => {
        const statusCode = (this.status === STATUS.INITIAL) ? 27904 : -1
        reject({ message: 'getAppConfiguration timed out', statusCode })
      }, 1000)

      this.eth.getAppConfiguration().then(resolve).catch(reject)
    })
  }

  // Standard Methods
  // TODO
  // async signMessage (index, message, cb) {
  //   try {
  //     if (this.pause) throw new Error('Device access is paused')
  //     const eth = await this.getDevice()
  //     const result = await eth.signPersonalMessage(this.getPath(index), message.replace('0x', ''))
  //     let v = (result.v - 27).toString(16)
  //     if (v.length < 2) v = '0' + v
  //     cb(null, '0x' + result.r + result.s + v)
  //     await this.releaseDevice()
  //     this.busyCount = 0
  //   } catch (err) {
  //     const deviceBusy = (
  //       err.message.startsWith('cannot open device with path') ||
  //       err.message === 'Device access is paused' ||
  //       err.message === 'Invalid channel' ||
  //       err.message === 'DisconnectedDevice'
  //     )
  //     if (deviceBusy) {
  //       clearTimeout(this._signMessage)
  //       if (++this.busyCount > 20) {
  //         this.busyCount = 0
  //         return log.info('>>>>>>> Busy: Limit (10) hit, cannot open device with path, will not try again')
  //       } else {
  //         this._signMessage = setTimeout(() => this.signMessage(index, message, cb), 700)
  //         return log.info('>>>>>>> Busy: cannot open device with path, will try again (signMessage)')
  //       }
  //     }
  //     cb(err)
  //     await this.releaseDevice()
  //     log.error(err)
  //   }
  // }

  // TODO
  // async signTransaction (index, rawTx, cb) {
  //   try {
  //     if (this.pause) throw new Error('Device access is paused')
  //     const eth = await this.getDevice()
  //     const signerPath = this.getPath(index)

  //     const compatibility = signerCompatibility(rawTx, this.summary())
  //     const ledgerTx = compatibility.compatible ? { ...rawTx } : londonToLegacy(rawTx)

  //     const signedTx = await sign(ledgerTx, tx => {
  //       // legacy transactions aren't RLP encoded before they're returned
  //       const message = tx.getMessageToSign(false)
  //       const legacyMessage = message[0] !== parseInt(tx.type)
  //       const rawTxHex = legacyMessage ? rlp.encode(message).toString('hex') : message.toString('hex')

  //       return eth.signTransaction(signerPath, rawTxHex)
  //     })

  //     const signedTxSerialized = signedTx.serialize().toString('hex')
  //     cb(null, addHexPrefix(signedTxSerialized))

  //     this.releaseDevice()
  //   } catch (err) {
  //     log.error(err)
  //     log.error(err.message)
  //     const deviceBusy = (
  //       err.message.startsWith('cannot open device with path') ||
  //       err.message === 'Device access is paused' ||
  //       err.message === 'Invalid channel' ||
  //       err.message === 'DisconnectedDevice'
  //     )
  //     if (deviceBusy) {
  //       clearTimeout(this._signTransaction)
  //       if (++this.busyCount > 20) {
  //         this.busyCount = 0
  //         cb(err)
  //         return log.info('>>>>>>> Busy: Limit (10) hit, cannot open device with path, will not try again')
  //       } else {
  //         this._signTransaction = setTimeout(() => this.signTransaction(index, rawTx, cb), 700)
  //         return log.info('>>>>>>> Busy: cannot open device with path, will try again (signTransaction)')
  //       }
  //     } else {
  //       cb(err)
  //     }
  //     this.releaseDevice()
  //     log.error(err)
  //   }
  // }
}
