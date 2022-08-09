import { constants, Contract, Wallet } from "ethers";
import {
    AddMarginParams,
    Asset,
    ClosePositionParams,
    Decimal,
    Direction,
    DirectionOfAsset,
    OpenPositionParams,
    PartialCloseParams,
    Position,
    Ratios,
    RemoveMarginParams,
    Side,
} from "./types/types";
import { Amm, ClearingHouse, ClearingHouseViewer, ERC20, InsuranceFund } from "./typechain-types";
import abis from "./abis";
import Big from "big.js";
import { format, fromDecimal, fromWei, toBig, toDecimal, toWei } from "./abis/utils/math/mathUtil";
import {
    getChAddress,
    getChvAddress,
    getAssetAddress,
    getIfAddress,
    getWethAddress,
    _throw,
} from "./abis/utils/helpers/helperUtil";

export class NFTPERP {
    private readonly _wallet: Wallet;

    private readonly _ch: ClearingHouse;
    private readonly _chv: ClearingHouseViewer;
    private readonly _if: InsuranceFund;
    private readonly _weth: ERC20;
    /**
     * @param wallet_ wallet signer used for making transactions
     */
    constructor(wallet_: Wallet) {
        this._wallet = wallet_;

        this._ch = new Contract(getChAddress(), abis.chAbi, wallet_) as ClearingHouse;
        this._chv = new Contract(getChvAddress(), abis.chvAbi, wallet_) as ClearingHouseViewer;
        this._if = new Contract(getIfAddress(), abis.ifAbi, wallet_) as InsuranceFund;
        this._weth = new Contract(getWethAddress(), abis.erc20Abi, wallet_) as ERC20;
    }

    /**
     * Open a new position
     * @returns tx hash
     */
    public async openPosition(params: OpenPositionParams): Promise<string> {
        const { asset, direction, margin, leverage, slippagePercent } = params;
        const notional = toBig(margin).mul(leverage);
        const side = this._getSide(direction);
        const fees = await this._calcFee(asset, notional, side);
        const totalCost = toWei(margin).add(fees);
        await this._checkBalance(totalCost);
        await this._checkAllowance(totalCost);
        const slippageAmount = await this._getSlippageBaseAssetAmount(
            asset,
            side,
            notional,
            slippagePercent
        );

        const hash = await this._openPosition(
            getAssetAddress(asset),
            side,
            toDecimal(toWei(margin)),
            toDecimal(toWei(leverage)),
            toDecimal(slippageAmount)
        );
        return hash;
    }

    public async closePosition(params: ClosePositionParams): Promise<string> {
        const { asset, slippagePercent } = params;
        const { size } = await this._getPosition(asset, this._wallet.address);
        const side = size.gt(0) ? Side.SELL : Side.BUY;
        const quoteAssetOut = await this._getQuoteAssetOut(
            asset,
            side === Side.SELL ? DirectionOfAsset.ADD_TO_AMM : DirectionOfAsset.REMOVE_FROM_AMM,
            size
        );
        const fees = await this._calcFee(asset, quoteAssetOut, side);
        await this._checkBalance(fees);
        await this._checkAllowance(fees);
        const slippageAmount = await this._getSlippageQuoteAssetAmount(
            asset,
            side,
            size,
            slippagePercent
        );

        const hash = this._closePosition(getAssetAddress(asset), toDecimal(slippageAmount));
        return hash;
    }

    public async partialClose(params: PartialCloseParams) {
        const { asset, partialClosePercent, slippagePercent } = params;
        const { size } = await this._getPosition(asset, this._wallet.address);
        const side = size.gt(0) ? Side.SELL : Side.BUY;
        const partialCloseFraction = toBig(partialClosePercent).div(100);
        const sizeToClose = size.mul(partialCloseFraction);
        const quoteAssetOut = await this._getQuoteAssetOut(
            asset,
            side === Side.SELL ? DirectionOfAsset.ADD_TO_AMM : DirectionOfAsset.REMOVE_FROM_AMM,
            sizeToClose
        );
        const fees = await this._calcFee(asset, quoteAssetOut, side);
        await this._checkBalance(fees);
        await this._checkAllowance(fees);
        const slippageAmount = await this._getSlippageQuoteAssetAmount(
            asset,
            side,
            sizeToClose,
            slippagePercent
        );

        const hash = await this._partialClose(
            getAssetAddress(asset),
            toDecimal(toWei(partialCloseFraction)),
            toDecimal(slippageAmount)
        );
        return hash;
    }

    public async addMargin(params: AddMarginParams): Promise<string> {
        const { asset, marginToAdd } = params;
        await this._checkBalance(toWei(marginToAdd));
        await this._checkAllowance(toWei(marginToAdd));

        const hash = await this._addMargin(getAssetAddress(asset), toDecimal(toWei(marginToAdd)));
        return hash;
    }

    public async removeMargin(params: RemoveMarginParams): Promise<string> {
        const { asset, marginToRemove } = params;
        const { positionNotional, upnl } = await this._getPositionNotionalAndUpnl(
            asset,
            this._wallet.address
        );
        const { margin } = await this._getPosition(asset, this._wallet.address);
        const { mmr } = await this._getRatios(asset);
        const newMarginRatio = margin.add(upnl).sub(toWei(marginToRemove)).div(positionNotional);
        if (newMarginRatio.lt(mmr)) {
            _throw(
                "position goes below mmr after removal. try removing a small amount to keep above mmr"
            );
        }

        const hash = await this._removeMargin(
            getAssetAddress(asset),
            toDecimal(toWei(marginToRemove))
        );
        return hash;
    }

    private async _getPosition(asset: Asset, trader: string): Promise<Position> {
        const { size, margin, openNotional } = await this._ch.getPosition(
            getAssetAddress(asset),
            trader
        );
        return {
            size: fromDecimal(size),
            margin: fromDecimal(margin),
            openNotional: fromDecimal(openNotional),
        };
    }

    private async _getMarginRatio(asset: Asset, trader: string): Promise<Big> {
        const marginRatio = await this._ch.getMarginRatio(getAssetAddress(asset), trader);
        return fromDecimal(marginRatio);
    }

    private async _getPositionNotionalAndUpnl(asset: Asset, trader: string) {
        const _ = await this._ch.getPositionNotionalAndUnrealizedPnl(
            getAssetAddress(asset),
            trader,
            0
        );
        return {
            positionNotional: fromDecimal(_.positionNotional),
            upnl: fromDecimal(_.unrealizedPnl),
        };
    }

    private async _getRatios(asset: Asset): Promise<Ratios> {
        const assetInstance = this._getAssetInstance(asset);
        const ratios = await assetInstance.getRatios();
        return {
            imr: fromDecimal(ratios.initMarginRatio),
            mmr: fromDecimal(ratios.maintenanceMarginRatio),
            plr: fromDecimal(ratios.partialLiquidationRatio),
            lfr: fromDecimal(ratios.liquidationFeeRatio),
        };
    }

    private async _calcFee(asset: Asset, notional: Big, side: Side) {
        const assetInstance = this._getAssetInstance(asset);
        const fees = await assetInstance.calcFee(toDecimal(toWei(notional)), side);
        return fromDecimal(fees[0]).add(fromDecimal(fees[1]));
    }

    private async _getAllowance(): Promise<Big> {
        return toBig(await this._weth.allowance(this._wallet.address, this._ch.address));
    }

    private async _maxApprove(): Promise<void> {
        const tx = await this._weth.approve(this._ch.address, constants.MaxUint256);
        await tx.wait();
    }

    private async _getBaseAssetOut(
        asset: Asset,
        dir: DirectionOfAsset,
        notional: Big
    ): Promise<Big> {
        const assetInstance = this._getAssetInstance(asset);
        const baseAssetOut = await assetInstance.getInputPrice(dir, toDecimal(toWei(notional)));
        return fromDecimal(baseAssetOut);
    }

    private async _getQuoteAssetOut(asset: Asset, dir: DirectionOfAsset, size: Big): Promise<Big> {
        const assetInstance = this._getAssetInstance(asset);
        const quoteAssetOut = await assetInstance.getOutputPrice(dir, toDecimal(size));
        return fromDecimal(quoteAssetOut);
    }

    private async _getSlippageBaseAssetAmount(
        asset: Asset,
        side: Side,
        notional: Big,
        slippagePercent?: number
    ): Promise<Big> {
        if (!slippagePercent) {
            return toBig(0);
        }
        const dir =
            side === Side.BUY ? DirectionOfAsset.ADD_TO_AMM : DirectionOfAsset.REMOVE_FROM_AMM;
        const baseAssetOut = await this._getBaseAssetOut(asset, dir, notional);
        const slippageFraction = Big(slippagePercent).div(100);
        if (side === Side.BUY) {
            return baseAssetOut.mul(toBig(1).sub(slippageFraction)).round(0, 0);
        }
        return baseAssetOut.mul(toBig(1).add(slippageFraction)).round(0, 1);
    }

    private async _getSlippageQuoteAssetAmount(
        asset: Asset,
        side: Side,
        size: Big,
        slippagePercent?: number
    ): Promise<Big> {
        if (!slippagePercent) {
            return toBig(0);
        }
        const dir =
            side === Side.SELL ? DirectionOfAsset.ADD_TO_AMM : DirectionOfAsset.REMOVE_FROM_AMM;
        const quoteAssetOut = await this._getQuoteAssetOut(asset, dir, size);
        const slippageFraction = Big(slippagePercent).div(100);
        if (side === Side.SELL) {
            return quoteAssetOut.mul(toBig(1).sub(slippageFraction)).round(0, 0);
        }
        return quoteAssetOut.mul(toBig(1).add(slippageFraction)).round(0, 1);
    }

    private _getAssetInstance(asset: Asset): Amm {
        return new Contract(getAssetAddress(asset), abis.ammAbi, this._wallet) as Amm;
    }

    private async _getBalance(): Promise<Big> {
        return toBig(await this._weth.balanceOf(this._wallet.address));
    }

    private async _checkBalance(amount: Big): Promise<void> {
        const balance = await this._getBalance();
        if (balance.lt(amount)) {
            _throw(`insufficient balance, required: ${format(fromWei(amount))}`);
        }
    }

    private async _checkAllowance(amount: Big): Promise<void> {
        const allowance = await this._getAllowance();
        if (allowance.lt(amount)) {
            await this._maxApprove();
        }
    }

    private async _openPosition(
        amm: string,
        side: Side,
        margin: Decimal,
        leverage: Decimal,
        baseAssetAmountLimit: Decimal
    ): Promise<string> {
        const tx = await this._ch.openPosition(
            amm,
            side,
            margin,
            leverage,
            baseAssetAmountLimit,
            false
        );
        await tx.wait();
        return tx.hash;
    }

    private async _closePosition(amm: string, quoteAssetAmountLimit: Decimal) {
        const tx = await this._ch.closePosition(amm, quoteAssetAmountLimit, false);
        await tx.wait();
        return tx.hash;
    }

    private async _partialClose(
        amm: string,
        partialCloseRatio: Decimal,
        quoteAssetAmountLimit: Decimal
    ): Promise<string> {
        const tx = await this._ch.partialClose(
            amm,
            partialCloseRatio,
            quoteAssetAmountLimit,
            false
        );
        await tx.wait();
        return tx.hash;
    }

    private async _addMargin(amm: string, marginToAdd: Decimal) {
        const tx = await this._ch.addMargin(amm, marginToAdd);
        await tx.wait();
        return tx.hash;
    }

    private async _removeMargin(amm: string, marginToRemove: Decimal): Promise<string> {
        const tx = await this._ch.removeMargin(amm, marginToRemove);
        await tx.wait();
        return tx.hash;
    }

    private _getSide(direction: Direction): Side {
        return direction === "long" ? Side.BUY : Side.SELL;
    }
}
