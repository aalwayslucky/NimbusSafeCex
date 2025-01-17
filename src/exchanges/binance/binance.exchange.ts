import type { Axios } from "axios";
import rateLimit from "axios-rate-limit";
import type { ManipulateType } from "dayjs";
import dayjs from "dayjs";
import chunk from "lodash/chunk";
import groupBy from "lodash/groupBy";
import omit from "lodash/omit";
import times from "lodash/times";
import { forEachSeries } from "p-iteration";
import OrderQueueManager from "./orderQueueManager";

import type { Store } from "../../store/store.interface";
import type {
  Candle,
  ExchangeOptions,
  Market,
  MutableBalance,
  OHLCVOptions,
  Order,
  OrderBook,
  PayloadOrder,
  PlaceOrderOpts,
  Position,
  SplidOrderOpts,
  Ticker,
  UpdateOrderOpts,
} from "../../types";
import {
  OrderTimeInForce,
  PositionSide,
  OrderSide,
  OrderStatus,
  OrderType,
} from "../../types";
import { v } from "../../utils/get-key";
import { inverseObj } from "../../utils/inverse-obj";
import { loop } from "../../utils/loop";
import { omitUndefined } from "../../utils/omit-undefined";
import { adjust, subtract } from "../../utils/safe-math";
import { generateOrderId, uuid } from "../../utils/uuid";
import { BaseExchange } from "../base";

import { createAPI } from "./binance.api";
import {
  ORDER_TYPE,
  ORDER_SIDE,
  POSITION_SIDE,
  ENDPOINTS,
  TIME_IN_FORCE,
} from "./binance.types";
import { BinancePrivateWebsocket } from "./binance.ws-private";
import { BinancePublicWebsocket } from "./binance.ws-public";
import {
  calculateWeights,
  calcValidOrdersCount,
} from "../../utils/scaleWeights";

export class BinanceExchange extends BaseExchange {
  name = "BINANCE";

  xhr: Axios;
  unlimitedXHR: Axios;

  publicWebsocket: BinancePublicWebsocket;
  privateWebsocket: BinancePrivateWebsocket;
  private orderQueueManager: OrderQueueManager;

  constructor(opts: ExchangeOptions, store: Store) {
    super(opts, store);

    this.xhr = rateLimit(createAPI(opts), { maxRPS: 3 });
    this.unlimitedXHR = createAPI(opts);
    this.orderQueueManager = new OrderQueueManager(
      this.emitter,
      this.placeOrderBatchFast.bind(this) // Pass the placeOrderBatch function
    );

    this.publicWebsocket = new BinancePublicWebsocket(this);
    this.privateWebsocket = new BinancePrivateWebsocket(this);
  }

  dispose = () => {
    super.dispose();
    this.publicWebsocket.dispose();
    this.privateWebsocket.dispose();
  };

  getAccount = async () => {
    const {
      data: [{ accountAlias }],
    } = await this.xhr.get(ENDPOINTS.BALANCE);

    return { userId: accountAlias };
  };

  validateAccount = async () => {
    try {
      await this.xhr.get(ENDPOINTS.ACCOUNT);
      return "";
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return err?.message?.toLowerCase()?.includes?.("network error")
        ? "Error while contacting Binance API"
        : err?.response?.data?.msg || "Invalid API key or secret";
    }
  };

  start = async () => {
    // load initial market data
    // then we can poll for live data
    const markets = await this.fetchMarkets();
    if (this.isDisposed) return;

    this.store.update({
      markets,
      loaded: { ...this.store.loaded, markets: true },
    });

    // load initial tickers data
    // then we use websocket for live data
    const tickers = await this.fetchTickers();
    if (this.isDisposed) return;

    this.log(
      `Loaded ${Math.min(tickers.length, markets.length)} Binance markets`
    );

    this.store.update({
      tickers,
      loaded: { ...this.store.loaded, tickers: true },
    });

    // start websocket streams
    this.publicWebsocket.connectAndSubscribe();
    this.privateWebsocket.connectAndSubscribe();

    // fetch current position mode (Hedge/One-way)
    this.store.setSetting("isHedged", await this.fetchPositionMode());

    // start ticking live data
    // balance, tickers, positions
    await this.tick();
    if (this.isDisposed) return;

    this.log(`Ready to trade on Binance`);

    // fetch unfilled orders
    const orders = await this.fetchOrders();
    if (this.isDisposed) return;

    this.log(`Loaded Binance orders`);

    this.store.update({
      orders,
      loaded: { ...this.store.loaded, orders: true },
    });
  };

  tick = async () => {
    if (!this.isDisposed) {
      try {
        const { balance, positions } = await this.fetchBalanceAndPositions();
        if (this.isDisposed) return;

        this.store.update({
          balance,
          positions,
          loaded: {
            ...this.store.loaded,
            balance: true,
            positions: true,
          },
        });
      } catch (err: any) {
        this.emitter.emit("error", err?.message);
      }

      loop(() => this.tick(), this.options.extra?.tickInterval);
    }
  };

  fetchMarkets = async () => {
    try {
      const {
        data: { symbols },
      } = await this.xhr.get<{ symbols: Array<Record<string, any>> }>(
        ENDPOINTS.MARKETS
      );

      const { data } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.LEVERAGE_BRACKET
      );
      // delisted symbols
      const unwantedSymbols = [
        "BTSUSDT",
        "TOMOUSDT",
        "SCUSDT",
        "HNTUSDT",
        "SRMUSDT",
        "FTTUSDT",
        "RAYUSDT",
        "CVCUSDT",
        "COCOSUSDT",
        "STRAXUSDT",
        "DGBUSDT",
        "CTKUSDT",
        "ANTUSDT",
      ];

      const filteredSymbols = symbols.filter(
        (symbol) => !unwantedSymbols.includes(symbol.symbol)
      );
      const markets: Market[] = filteredSymbols
        .filter(
          (m) =>
            v(m, "contractType") === "PERPETUAL" &&
            v(m, "marginAsset") === "USDT"
        )
        .map((m) => {
          const p = m.filters.find(
            (f: any) => v(f, "filterType") === "PRICE_FILTER"
          );

          const amt = m.filters.find(
            (f: any) => v(f, "filterType") === "LOT_SIZE"
          );
          const notional = m.filters.find(
            (f: any) => v(f, "filterType") === "MIN_NOTIONAL"
          );
          const mAmt = m.filters.find(
            (f: any) => v(f, "filterType") === "MARKET_LOT_SIZE"
          );

          const { brackets } = data.find((b) => b.symbol === m.symbol)!;
          const baseAsset = v(m, "baseAsset");
          const quoteAsset = v(m, "quoteAsset");
          const marginAsset = v(m, "marginAsset");

          return {
            id: `${baseAsset}/${quoteAsset}:${marginAsset}`,
            symbol: m.symbol,
            base: baseAsset,
            quote: quoteAsset,
            active: m.status === "TRADING",
            precision: {
              amount: parseFloat(v(amt, "stepSize")),
              price: parseFloat(v(p, "tickSize")),
            },
            limits: {
              amount: {
                min: Math.max(
                  parseFloat(v(amt, "minQty")),
                  parseFloat(v(mAmt, "minQty"))
                ),
                max: Math.min(
                  parseFloat(v(amt, "maxQty")),
                  parseFloat(v(mAmt, "maxQty"))
                ),
              },
              minNotional: parseFloat(v(notional, "notional")),

              leverage: {
                min: 1,
                max: v(brackets[0], "initialLeverage"),
              },
            },
          };
        });

      return markets;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.markets;
    }
  };

  fetchTickers = async () => {
    try {
      const { data: dailys } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_24H
      );

      const { data: books } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_BOOK
      );

      const { data: prices } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.TICKERS_PRICE
      );

      const tickers: Ticker[] = books.reduce((acc: Ticker[], book) => {
        const market = this.store.markets.find((m) => m.symbol === book.symbol);

        const daily = dailys.find((d) => d.symbol === book.symbol)!;
        const price = prices.find((p) => p.symbol === book.symbol)!;

        if (!market || !daily || !price) return acc;

        const ticker = {
          id: market.id,
          symbol: market.symbol,
          bid: parseFloat(v(book, "bidPrice")),
          ask: parseFloat(v(book, "askPrice")),
          last: parseFloat(v(daily, "lastPrice")),
          mark: parseFloat(v(price, "markPrice")),
          index: parseFloat(v(price, "indexPrice")),
          percentage: parseFloat(v(daily, "priceChangePercent")),
          fundingRate: parseFloat(v(price, "lastFundingRate")),
          volume: parseFloat(daily.volume),
          quoteVolume: parseFloat(v(daily, "quoteVolume")),
          openInterest: 0, // Binance doesn't provides all tickers data
        };

        return [...acc, ticker];
      }, []);

      return tickers;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.tickers;
    }
  };

  fetchBalanceAndPositions = async () => {
    try {
      const { data } = await this.xhr.get<
        Record<string, any> & { positions: Array<Record<string, any>> }
      >(ENDPOINTS.ACCOUNT);

      const balance: MutableBalance = {
        total: 0,
        free: parseFloat(data.availableBalance),
        used: parseFloat(data.totalInitialMargin),
        upnl: parseFloat(data.totalUnrealizedProfit),
        assets: [],
      };

      for (const assetData of data.assets) {
        const walletBalance = parseFloat(assetData.walletBalance);

        // Only process assets with a non-zero wallet balance
        if (walletBalance > 0) {
          const asset = assetData.asset;
          let usdValue = walletBalance;

          // Calculate USD value for non-stablecoin assets
          if (!["USDC", "USDT", "FDUSD"].includes(asset)) {
            const symbol = asset + "USDT";
            const ticker = this.store.tickers.find((t) => t.symbol === symbol);
            if (!ticker) {
              throw new Error(`Ticker ${symbol} not found`);
            }
            usdValue = ticker.last * walletBalance;
          }

          // Add the asset details to the assets array
          balance.assets.push({
            symbol: asset,
            walletBalance,
            usdValue,
          });

          // Accumulate the total USD value
          balance.total = balance.assets.reduce(
            (sum, asset) => sum + asset.usdValue,
            0
          );
        }
      }

      // We need to filter out positions that corresponds to
      // markets that are not supported by safe-cex

      const supportedPositions = data.positions.filter((p) =>
        this.store.markets.some((m) => m.symbol === p.symbol)
      );

      const positions: Position[] = supportedPositions.map((p) => {
        const entryPrice = parseFloat(v(p, "entryPrice"));
        const contracts = parseFloat(v(p, "positionAmt"));
        const upnl = parseFloat(v(p, "unrealizedProfit"));
        const pSide = v(p, "positionSide");

        // If account is not on hedge mode,
        // we need to define the side of the position with the contracts amount
        const side =
          (pSide in POSITION_SIDE && POSITION_SIDE[pSide]) ||
          (contracts > 0 ? PositionSide.Long : PositionSide.Short);

        return {
          symbol: p.symbol,
          side,
          entryPrice,
          notional: Math.abs(contracts * entryPrice + upnl),
          leverage: parseFloat(p.leverage),
          unrealizedPnl: upnl,
          contracts: Math.abs(contracts),
          liquidationPrice: parseFloat(v(p, "liquidationPrice")),
        };
      });

      return {
        positions,
        balance,
      };
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);

      return {
        positions: this.store.positions,
        balance: this.store.balance,
      };
    }
  };

  fetchOrders = async () => {
    try {
      const { data } = await this.xhr.get<Array<Record<string, any>>>(
        ENDPOINTS.OPEN_ORDERS
      );

      const orders: Order[] = data.map((o) => {
        const order = {
          id: v(o, "clientOrderId"),
          orderId: v(o, "orderId"),
          status: OrderStatus.Open,
          symbol: o.symbol,
          type: ORDER_TYPE[o.type],
          side: ORDER_SIDE[o.side],
          price: parseFloat(o.price) || parseFloat(v(o, "stopPrice")),
          amount: parseFloat(v(o, "origQty")),
          reduceOnly: v(o, "reduceOnly") || false,
          filled: parseFloat(v(o, "executedQty")),
          remaining: subtract(v(o, "origQty"), v(o, "executedQty")),
        };

        return order;
      });

      return orders;
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      return this.store.orders;
    }
  };

  fetchOHLCV = async (opts: OHLCVOptions) => {
    const interval = opts.interval;
    const limit = Math.min(opts.limit || 500, 1500);
    const [, amount, unit] = opts.interval.split(/(\d+)/);

    const end = opts.to ? dayjs(opts.to) : dayjs();
    const start =
      !opts.limit && opts.from
        ? dayjs(opts.from)
        : end.subtract(parseFloat(amount) * limit, unit as ManipulateType);

    const { data } = await this.xhr.get<any[][]>(ENDPOINTS.KLINE, {
      params: {
        symbol: opts.symbol,
        interval,
        startTime: start.valueOf(),
        endTime: end.valueOf(),
        limit,
      },
    });

    const candles: Candle[] = data.map(
      ([time, open, high, low, close, volume]) => {
        return {
          timestamp: time / 1000,
          open: parseFloat(open),
          high: parseFloat(high),
          low: parseFloat(low),
          close: parseFloat(close),
          volume: parseFloat(volume),
        };
      }
    );

    return candles;
  };

  listenOHLCV = (opts: OHLCVOptions, callback: (candle: Candle) => void) => {
    return this.publicWebsocket.listenOHLCV(opts, callback);
  };

  listenOrderBook = (
    symbol: string,
    callback: (orderBook: OrderBook) => void
  ) => {
    return this.publicWebsocket.listenOrderBook(symbol, callback);
  };

  fetchPositionMode = async () => {
    const { data } = await this.xhr.get(ENDPOINTS.HEDGE_MODE);
    return data.dualSidePosition === true;
  };

  changePositionMode = async (hedged: boolean) => {
    if (this.store.positions.filter((p) => p.contracts > 0).length > 0) {
      this.emitter.emit(
        "error",
        "Please close all positions before switching position mode"
      );
      return;
    }

    try {
      await this.xhr.post(ENDPOINTS.HEDGE_MODE, {
        dualSidePosition: hedged ? "true" : "false",
      });
      this.store.setSetting("isHedged", hedged);
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  setLeverage = async (symbol: string, inputLeverage: number) => {
    const market = this.store.markets.find((m) => m.symbol === symbol);
    const position = this.store.positions.find((p) => p.symbol === symbol);

    if (!market) throw new Error(`Market ${symbol} not found`);
    if (!position) throw new Error(`Position ${symbol} not found`);

    const leverage = Math.min(
      Math.max(inputLeverage, market.limits.leverage.min),
      market.limits.leverage.max
    );

    if (position.leverage !== leverage) {
      try {
        await this.xhr.post(ENDPOINTS.SET_LEVERAGE, {
          symbol,
          leverage,
        });

        this.store.updatePositions([
          [{ symbol, side: PositionSide.Long }, { leverage }],
          [{ symbol, side: PositionSide.Short }, { leverage }],
        ]);
      } catch (err: any) {
        this.emitter.emit("error", err?.response?.data?.msg || err?.message);
      }
    }
  };

  cancelOrders = async (orders: Order[]) => {
    try {
      const groupedBySymbol = groupBy(orders, "symbol");
      const requests = Object.entries(groupedBySymbol).map(
        ([symbol, symbolOrders]) => ({
          symbol,
          origClientOrderIdList: symbolOrders.map((o) => o.id),
        })
      );

      await forEachSeries(requests, async (request) => {
        if (request.origClientOrderIdList.length === 1) {
          await this.xhr.delete(ENDPOINTS.ORDER, {
            params: {
              symbol: request.symbol,
              origClientOrderId: request.origClientOrderIdList[0],
            },
          });
        } else {
          const lots = chunk(request.origClientOrderIdList, 10);
          await forEachSeries(lots, async (lot) => {
            await this.xhr.delete(ENDPOINTS.BATCH_ORDERS, {
              params: {
                symbol: request.symbol,
                origClientOrderIdList: JSON.stringify(lot),
              },
            });
          });
        }

        this.store.removeOrders(
          request.origClientOrderIdList.map((id) => ({ id }))
        );
      });
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  cancelSymbolOrders = async (symbol: string) => {
    try {
      await this.xhr.delete(ENDPOINTS.CANCEL_SYMBOL_ORDERS, {
        params: { symbol },
      });

      this.store.removeOrders(
        this.store.orders.filter((o) => o.symbol === symbol)
      );
    } catch (err: any) {
      this.emitter.emit("error", err?.response?.data?.msg || err?.message);
    }
  };

  updateOrder = async ({ order, update }: UpdateOrderOpts) => {
    const newOrder = {
      symbol: order.symbol,
      type: order.type,
      side: order.side,
      price: order.price,
      amount: order.amount,
      reduceOnly: order.reduceOnly || false,
    };

    if ("price" in update) newOrder.price = update.price;
    if ("amount" in update) newOrder.amount = update.amount;

    await this.cancelOrders([order]);
    return await this.placeOrder(newOrder);
  };

  placeOrder = async (opts: PlaceOrderOpts) => {
    const payloads = this.formatCreateOrder(opts);
    return await this.placeOrderBatch(payloads);
  };

  placeOrders = async (orders: PlaceOrderOpts[]) => {
    const requests = orders.flatMap((o) => this.formatCreateOrder(o));
    return await this.placeOrderBatch(requests);
  };
  placeSplitOrder = async (opts: SplidOrderOpts) => {
    const payloads = this.formatCreateSplitOrders(opts);
    await this.orderQueueManager.enqueueOrders(payloads);

    // Wait for the OrderQueueManager to finish processing
    while (this.orderQueueManager.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const data = this.orderQueueManager.getResults();
    // Return the results
    return data;
  };

  placeOrdersFast = async (orders: PlaceOrderOpts[]) => {
    const requests = orders.flatMap((o) => this.formatCreateOrder(o));

    // Enqueue all requests in the OrderQueueManager
    await this.orderQueueManager.enqueueOrders(requests);

    // Wait for the OrderQueueManager to finish processing
    while (this.orderQueueManager.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const data = this.orderQueueManager.getResults();
    // Return the results
    return data;
  };
  private formatCreateSplitOrders = (opts: SplidOrderOpts) => {
    const orders: PayloadOrder[] = [];
    const market = this.store.markets.find(({ symbol }: Market) => {
      return symbol === opts.symbol;
    });
    const ticker = this.store.tickers.find(({ symbol }: Ticker) => {
      return symbol === opts.symbol;
    });

    if (!market) {
      throw new Error(`Market ${opts.symbol} not found`);
    }
    if (!ticker) {
      throw new Error(`Ticker ${opts.symbol} not found`);
    }
    const minSize = market.limits.amount.min;
    const minNotional = market.limits.minNotional;
    const pPrice = market.precision.price;
    const pAmount = market.precision.amount;
    const pSide = this.getOrderPositionSide(opts);

    // We use price only for limit orders
    // Market order should not define price
    // Binance stopPrice only for SL or TP orders
    const avgPrice = (opts.fromPrice + opts.toPrice) / 2;

    const quantity = opts.amount / avgPrice;
    this.emitter.emit("info", `Splitting ${opts.amount} into ${opts.orders}`);
    this.emitter.emit("info", `Quantity: ${quantity}`);
    let totalQuantity = 0;
    const totalWeight = calculateWeights({
      fromScale: opts.fromScale,
      toScale: opts.toScale,
      orders: opts.orders,
    });
    const lowestSize = (opts.fromScale / totalWeight) * quantity;

    if (lowestSize < minSize || lowestSize * opts.fromPrice < minNotional) {
      if (opts.autoReAdjust) {
        const validOrdersAmount = calcValidOrdersCount({
          fromScale: opts.fromScale,
          toScale: opts.toScale,
          orders: opts.orders,
          amount: quantity,
          minSize: minSize,
          minNotional: minNotional,
          totalWeight: totalWeight,
          fromPrice: opts.fromPrice,
        });
        if (validOrdersAmount < 3) {
          this.emitter.emit(
            "error",
            "Bruh either u poor or retardio cannot split"
          );
          return [];
        }
        const reAdjustedWeight = calculateWeights({
          fromScale: opts.fromScale,
          toScale: opts.toScale,
          orders: validOrdersAmount,
        });
        const newLowestSize = (opts.fromScale / reAdjustedWeight) * quantity;
        if (
          newLowestSize < minSize ||
          newLowestSize * opts.fromPrice < minNotional
        ) {
          this.emitter.emit(
            "error",
            `WTF u doing something wrong wen spliting orders ${validOrdersAmount}`
          );
          return [];
        }
      } else {
        this.emitter.emit(
          "error",
          "Scale too extreme to split orders - no adjustments made"
        );
        return [];
      }
    }
    const priceDifference = opts.toPrice - opts.fromPrice;
    const priceStep = priceDifference / (opts.orders - 1);
    for (let i = 0; i < opts.orders; i++) {
      const weightOfOrder =
        opts.fromScale +
        (opts.toScale - opts.fromScale) * (i / (opts.orders - 1));
      let sizeOfOrder = quantity * (weightOfOrder / totalWeight);
      const price: number = opts.fromPrice + priceStep * i;
      if (sizeOfOrder * price < minNotional * 1.05) {
        sizeOfOrder = (minNotional * 1.1) / price;
      }

      const req: PayloadOrder = omitUndefined({
        symbol: opts.symbol,
        positionSide: pSide,
        side: inverseObj(ORDER_SIDE)[opts.side],
        type: inverseObj(ORDER_TYPE)[opts.type],
        quantity: adjust(sizeOfOrder, pAmount),
        timeInForce: "GTC",
        price: adjust(price, pPrice),
        reduceOnly: "false",
        newClientOrderId: generateOrderId(),
      });

      orders.push(req);
      totalQuantity += adjust(sizeOfOrder, pAmount);
    }
    this.emitter.emit("info", `Total Quantity: ${totalQuantity}`);
    return orders;
  };
  // eslint-disable-next-line complexity
  private formatCreateOrder = (opts: PlaceOrderOpts) => {
    if (opts.type === OrderType.TrailingStopLoss) {
      return this.formatCreateTrailingStopLossOrder(opts);
    }

    const market = this.store.markets.find(({ symbol }) => {
      return symbol === opts.symbol;
    });

    if (!market) {
      throw new Error(`Market ${opts.symbol} not found`);
    }

    const isStopOrTP =
      opts.type === OrderType.StopLoss || opts.type === OrderType.TakeProfit;

    const pSide = this.getOrderPositionSide(opts);

    const maxSize = market.limits.amount.max;
    const pPrice = market.precision.price;

    const pAmount = market.precision.amount;
    const amount = adjust(opts.amount, pAmount);

    // We use price only for limit orders
    // Market order should not define price
    const price =
      opts.price && opts.type !== OrderType.Market
        ? adjust(opts.price, pPrice)
        : undefined;

    // Binance stopPrice only for SL or TP orders
    const priceField = isStopOrTP ? "stopPrice" : "price";

    const reduceOnly = !this.store.options.isHedged && opts.reduceOnly;
    const timeInForce = opts.timeInForce
      ? inverseObj(TIME_IN_FORCE)[opts.timeInForce]
      : inverseObj(TIME_IN_FORCE)[OrderTimeInForce.GoodTillCancel];

    const req = omitUndefined({
      symbol: opts.symbol,
      positionSide: pSide,
      side: inverseObj(ORDER_SIDE)[opts.side],
      type: inverseObj(ORDER_TYPE)[opts.type],
      quantity: amount ? `${amount}` : undefined,
      [priceField]: price ? `${price}` : undefined,
      timeInForce: opts.type === OrderType.Limit ? timeInForce : undefined,
      closePosition: isStopOrTP ? "true" : undefined,
      reduceOnly: reduceOnly && !isStopOrTP ? "true" : undefined,
    });

    const lots = amount > maxSize ? Math.ceil(amount / maxSize) : 1;
    const rest = amount > maxSize ? adjust(amount % maxSize, pAmount) : 0;

    const lotSize = adjust((amount - rest) / lots, pAmount);

    const payloads: Array<Record<string, any>> = times(lots, () => ({
      ...req,
      quantity: `${lotSize}`,
    }));

    if (rest) {
      payloads.push({ ...req, quantity: `${rest}` });
    }

    if (opts.stopLoss) {
      payloads.push({
        ...omit(req, "price"),
        side: inverseObj(ORDER_SIDE)[
          opts.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy
        ],
        type: inverseObj(ORDER_TYPE)[OrderType.StopLoss],
        stopPrice: `${opts.stopLoss}`,
        timeInForce: "GTC",
        closePosition: "true",
      });
    }

    if (opts.takeProfit) {
      payloads.push({
        ...omit(req, "price"),
        side: inverseObj(ORDER_SIDE)[
          opts.side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy
        ],
        type: inverseObj(ORDER_TYPE)[OrderType.TakeProfit],
        stopPrice: `${opts.takeProfit}`,
        timeInForce: "GTC",
        closePosition: "true",
      });
    }

    // We need to set orderId for each order
    // otherwise Binance will duplicate the IDs
    // when its sent in batches
    for (const payload of payloads) {
      payload.newClientOrderId = uuid();
    }

    return payloads;
  };

  private formatCreateTrailingStopLossOrder = (opts: PlaceOrderOpts) => {
    const market = this.store.markets.find((m) => m.symbol === opts.symbol);
    const ticker = this.store.tickers.find((t) => t.symbol === opts.symbol);

    const pSide =
      opts.side === OrderSide.Buy ? PositionSide.Short : PositionSide.Long;

    const position = this.store.positions.find(
      (p) => p.symbol === opts.symbol && p.side === pSide
    );

    if (!market) throw new Error(`Market ${opts.symbol} not found`);
    if (!ticker) throw new Error(`Ticker ${opts.symbol} not found`);

    if (!position) {
      throw new Error(`Position ${opts.symbol} and side ${pSide} not found`);
    }

    const priceDistance = adjust(
      Math.max(ticker.last, opts.price!) - Math.min(ticker.last, opts.price!),
      market.precision.price
    );

    const distancePercentage =
      Math.round(((priceDistance * 100) / ticker.last) * 10) / 10;

    const payload = {
      symbol: opts.symbol,
      positionSide: this.getOrderPositionSide(opts),
      side: inverseObj(ORDER_SIDE)[opts.side],
      type: inverseObj(ORDER_TYPE)[OrderType.TrailingStopLoss],
      quantity: `${position.contracts}`,
      callbackRate: `${distancePercentage}`,
      priceProtect: "true",
      newClientOrderId: uuid(),
    };

    return [payload];
  };

  private getOrderPositionSide = (opts: PlaceOrderOpts) => {
    let positionSide = "BOTH";

    // We need to specify side of the position to interract with
    // if we are in hedged mode on the binance account
    if (this.store.options.isHedged) {
      positionSide = opts.side === OrderSide.Buy ? "LONG" : "SHORT";

      if (
        opts.type === OrderType.StopLoss ||
        opts.type === OrderType.TakeProfit ||
        opts.type === OrderType.TrailingStopLoss ||
        opts.reduceOnly
      ) {
        positionSide = positionSide === "LONG" ? "SHORT" : "LONG";
      }
    }

    return positionSide;
  };

  private placeOrderBatch = async (payloads: any[]) => {
    const lots = chunk(payloads, 5);
    const orderIds = [] as string[];

    for (const lot of lots) {
      if (lot.length === 1) {
        try {
          await this.unlimitedXHR.post(ENDPOINTS.ORDER, lot[0]);
          orderIds.push(lot[0].newClientOrderId);
        } catch (err: any) {
          this.emitter.emit("error", err?.response?.data?.msg || err?.message);
        }
      }

      if (lot.length > 1) {
        const { data } = await this.unlimitedXHR.post(ENDPOINTS.BATCH_ORDERS, {
          batchOrders: JSON.stringify(lot),
        });

        data?.forEach?.((o: any) => {
          if (o.code) {
            this.emitter.emit("error", o.msg);
          } else {
            orderIds.push(o.clientOrderId);
          }
        });
      }
    }

    return orderIds;
  };
  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  private placeOrderBatchFast = async (payloads: any[]) => {
    const lots = chunk(payloads, 5);
    const orderResults = [] as { orderId: string; error: any }[];

    const promises = lots.map(async (lot) => {
      if (lot.length === 1) {
        try {
          await this.unlimitedXHR.post(ENDPOINTS.ORDER, lot[0]);
          orderResults.push({ orderId: lot[0].newClientOrderId, error: null });
        } catch (err: any) {
          orderResults.push({
            orderId: lot[0].newClientOrderId,
            error: err?.response?.data?.msg || err?.message,
          });
        }
      }

      if (lot.length > 1) {
        try {
          const { data } = await this.unlimitedXHR.post(
            ENDPOINTS.BATCH_ORDERS,
            {
              batchOrders: JSON.stringify(lot),
            }
          );
          await this.sleep(70);

          data?.forEach?.((o: any, index: number) => {
            const originalOrder = lot[index];
            if (o.code) {
              orderResults.push({
                orderId: originalOrder.newClientOrderId,
                error: o,
              });
            } else {
              orderResults.push({
                orderId: originalOrder.newClientOrderId,
                error: null,
              });
            }
          });
        } catch (err: any) {
          lot.forEach((o: any) => {
            orderResults.push({
              orderId: o.newClientOrderId,
              error: err?.response?.data?.msg || err?.message,
            });
          });
        }
      }
    });

    await Promise.all(promises);

    return orderResults;
  };
}
