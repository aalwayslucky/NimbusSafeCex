import { OrderStatus, WalletAsset } from "../../types";
import { jsonParse } from "../../utils/json-parse";
import { BaseWebSocket } from "../base.ws";

import type { BinanceExchange } from "./binance.exchange";
import {
  BASE_WS_URL,
  ENDPOINTS,
  ORDER_SIDE,
  ORDER_TYPE,
  POSITION_SIDE,
} from "./binance.types";

export class BinancePrivateWebsocket extends BaseWebSocket<BinanceExchange> {
  connectAndSubscribe = async () => {
    if (!this.isDisposed) {
      const listenKey = await this.fetchListenKey();

      const key = this.parent.options.testnet ? "testnet" : "livenet";
      const base = BASE_WS_URL.private[key];

      const url = `${base}/${listenKey}`;

      this.ws = new WebSocket(url);
      this.ws.addEventListener("message", this.onMessage);
      this.ws.addEventListener("close", this.onClose);
      this.ws.addEventListener("open", this.onOpen);
    }
  };

  onOpen = () => {
    if (!this.isDisposed) {
      this.ping();
    }
  };

  onMessage = ({ data }: MessageEvent) => {
    if (!this.isDisposed) {
      const json = jsonParse(data);

      if (json?.e === "ACCOUNT_UPDATE") this.handleAccountEvents([json]);
      if (json?.e === "ORDER_TRADE_UPDATE") this.handleOrderEvents([json]);

      if (json?.id === 42) {
        const diff = performance.now() - this.pingAt;
        this.store.update({ latency: Math.round(diff / 2) });

        if (this.pingTimeoutId) {
          clearTimeout(this.pingTimeoutId);
          this.pingTimeoutId = undefined;
        }

        this.pingTimeoutId = setTimeout(() => this.ping(), 10_000);
      }
    }
  };

  ping = () => {
    if (!this.isDisposed) {
      this.pingAt = performance.now();
      this.ws?.send?.(JSON.stringify({ id: 42, method: "LIST_SUBSCRIPTIONS" }));
    }
  };

  handleOrderEvents = (events: Array<Record<string, any>>) => {
    events.forEach(({ o: data }) => {
      if (data.X === "PARTIALLY_FILLED" || data.X === "FILLED") {
        this.parent.emitter.emit("fill", {
          id: data.c,
          timestamp: data.T,
          side: ORDER_SIDE[data.S],
          symbol: data.s,
          price: parseFloat(data.ap),
          realizedPnl: parseFloat(data.rp),
          amount: parseFloat(data.l),
          reduceOnly: data.R || false,
          maker: data.m,
          notional: parseFloat(data.l) * parseFloat(data.ap),
          ...(data.n && { commission: parseFloat(data.n) }), // Add condition to check if commission exists
        });
      }

      if (data.X === "NEW") {
        this.store.addOrUpdateOrder({
          id: data.c,
          orderId: data.i,
          status: OrderStatus.Open,
          symbol: data.s,
          type: ORDER_TYPE[data.ot],
          side: ORDER_SIDE[data.S],
          price: parseFloat(data.p) || parseFloat(data.sp),
          amount: parseFloat(data.q),
          filled: parseFloat(data.z),
          remaining: parseFloat(data.q) - parseFloat(data.z),
          reduceOnly: data.R || false,
        });
      }

      if (
        data.X === "CANCELED" ||
        data.X === "FILLED" ||
        data.X === "EXPIRED"
      ) {
        this.store.removeOrder({ id: data.c });
      }
    });
  };

  handleAccountEvents = (events: Array<Record<string, any>>) => {
    events.forEach((event) => {
      // Handle position updates
      this.parent.emitter.emit("positionUpdate", event);

      event.a.P.forEach((p: Record<string, any>) => {
        const symbol = p.s;
        const side = POSITION_SIDE[p.ps];

        const position = this.parent.store.positions.find(
          (p2) => p2.symbol === symbol && p2.side === side
        );

        if (position) {
          const entryPrice = parseFloat(p.ep);
          const contracts = parseFloat(p.pa);
          const upnl = parseFloat(p.up);

          this.store.updatePosition(position, {
            entryPrice,
            contracts,
            notional: contracts * entryPrice + upnl,
            unrealizedPnl: upnl,
          });
        }
      });

      // Handle balance updates
      event.a.B.forEach((b: Record<string, any>) => {
        const symbol = b.a;
        const walletBalance = parseFloat(b.wb);

        const assetIndex = this.parent.store.balance.assets.findIndex(
          (a) => a.symbol === symbol
        );

        if (assetIndex !== -1) {
          const newAsset: WalletAsset = {
            ...this.parent.store.balance.assets[assetIndex],
            walletBalance: walletBalance,
          };

          this.parent.store.balance.assets[assetIndex] = newAsset;
        }
      });

      this.parent.store.updateBalance(this.parent.store.balance);
    });
  };

  private fetchListenKey = async () => {
    const { data } = await this.parent.xhr.post(ENDPOINTS.LISTEN_KEY);
    setTimeout(() => this.updateListenKey(), 30 * 60 * 1000);
    return data.listenKey;
  };

  private updateListenKey = async () => {
    if (!this.isDisposed) {
      await this.parent.xhr.put(ENDPOINTS.LISTEN_KEY);
      setTimeout(() => this.updateListenKey(), 30 * 60 * 1000);
    }
  };
}
