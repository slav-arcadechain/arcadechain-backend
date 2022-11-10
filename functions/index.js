const functions = require("firebase-functions");
const admin = require('firebase-admin');
const ethers = require('ethers');
const cors = require('cors');
const Moralis = require("moralis-v1/node");
const axios = require('axios');
const Web3Utils = require('web3-utils');
const BN = require('bn.js');

admin.initializeApp(functions.config().firebase);

exports.getSlotGameCount = functions.https.onRequest(async (req, res) => {
    await startMoralis();
    const lastMonday = getLastMonday();
    const wallet = req.body.address;

    cors()(req, res, async () => {
        if (wallet && ethers.utils.isAddress(wallet)) {
            const polygonQuery = new Moralis.Query("SlotGameEnteredPolygon");
            polygonQuery.equalTo("user", wallet.toLowerCase())
            polygonQuery.greaterThan("createdAt", lastMonday);
            const polygonCount = await polygonQuery.count();
            console.log("Slot played by wallet: " + wallet)
            console.log("   polygon: " + polygonCount);

            const bscQuery = new Moralis.Query("SlotGameEnteredBsc");
            bscQuery.equalTo("user", req.body.address.toLowerCase())
            bscQuery.greaterThan("createdAt", lastMonday);
            const bscCount = await bscQuery.count();
            console.log("   binance: " + bscCount);
            console.log("   total: " + (+polygonCount + bscCount));

            return res.json(+polygonCount + bscCount);
        }
        return res.status(404).json({status: 'Not Found'});
    });
});

exports.faucet = functions.https.onRequest(async (req, res) => {
    cors()(req, res, async () => {
        const remoteConfigTemplate = await getConfigTemplate();

        console.log(req.body)

        const erc20TransferAbi = "[{\"type\":\"function\",\"stateMutability\":\"nonpayable\",\"outputs\":[{\"type\":\"bool\",\"name\":\"\",\"internalType\":\"bool\"}],\"name\":\"transfer\",\"inputs\":[{\"type\":\"address\",\"name\":\"to\",\"internalType\":\"address\"},{\"type\":\"uint256\",\"name\":\"amount\",\"internalType\":\"uint256\"}]}]";
        let provider;
        let erc20_rw;
        if (req.body.chain === 'polygon') {
            provider = new ethers.providers.JsonRpcProvider("https://rpc-mumbai.maticvigil.com/v1/c542596d3086e52602d4c9d913d1c6f709639f08");
            const signer = new ethers.Wallet(remoteConfigTemplate.parameters.testPK.defaultValue.value, provider);
            erc20_rw = new ethers.Contract("0x912aAEA32355DA6FeB20D98E73B9C81B5afd6A2e", erc20TransferAbi, signer)
        } else if (req.body.chain === 'binance') {
            provider = new ethers.providers.JsonRpcProvider("https://data-seed-prebsc-1-s3.binance.org:8545");
            const signer = new ethers.Wallet(remoteConfigTemplate.parameters.testPK.defaultValue.value, provider);
            erc20_rw = new ethers.Contract("0x0A80797c23971590342edb9AEc08E713D31D63f1", erc20TransferAbi, signer)
        }

        await erc20_rw.transfer(req.body.wallet, '100000000000000000000');

        return res.json({status: 'ok'});
    });
});


exports.weeklyCalculations = functions.https.onRequest(async (req, res) => {
    const playersForPreviousWeek = await getPlayersForPreviousWeek()
    const qualifiedGamesForPreviousWeek = await getQualifiedGamesForPreviousWeek(playersForPreviousWeek)

    if (!qualifiedGamesForPreviousWeek || qualifiedGamesForPreviousWeek.length === 0) {
        console.warn("none of the players holds ACT this week - no rewards given");
        return res.status(200).json({status: 'none of the players holds ACT this week - no rewards given'});
    }

    const goldenTicketWinner = await getGoldenTicketWinner(qualifiedGamesForPreviousWeek);
    const {addresses, weights} = await getRewardedAllocations(qualifiedGamesForPreviousWeek);

    await callTreasuryContract(goldenTicketWinner, addresses, weights);

    return res.status(200).json({
        status: 'success',
        'goldenTicketWinner': goldenTicketWinner,
        'addresses': addresses,
        'weights': weights
    })
});

async function callTreasuryContract(goldenTicketWinner, addresses, weights) {
    const remoteConfigTemplate = await getConfigTemplate()
    const treasuryWeeklyCalculationAbi = "[{\"inputs\":[{\"internalType\":\"address\",\"name\":\"goldenTicketWinner\",\"type\":\"address\"},{\"internalType\":\"address[]\",\"name\":\"_usersWallets\",\"type\":\"address[]\"},{\"internalType\":\"uint256[]\",\"name\":\"_weights\",\"type\":\"uint256[]\"}],\"name\":\"weeklyCalculation\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}]";
    let provider = new ethers.providers.JsonRpcProvider("https://rpc-mumbai.maticvigil.com/v1/c542596d3086e52602d4c9d913d1c6f709639f08");
    const signer = new ethers.Wallet(remoteConfigTemplate.parameters.testPK.defaultValue.value, provider);
    let contract = new ethers.Contract('0x5AAbB68890a559d0aF981F5CCBBc089e1eAE9711', treasuryWeeklyCalculationAbi, signer);
    await contract.weeklyCalculation(goldenTicketWinner, addresses, weights, {gasPrice: 4500000000, gasLimit: 500000});
}

function getUniqueAddresses(playersForPreviousWeek) {
    const uniq = [...new Set(playersForPreviousWeek.map(e => e.get("address")))];
    return Array.from(uniq);
}

async function getRewardedAllocations(qualifiedGamesForPreviousWeek) {
    const addresses = [];
    const weights = [];
    let totalSum = 0;
    for (const addressActData of qualifiedGamesForPreviousWeek) {
        let weeklyAverage = addressActData.weeklyHoldings.reduce((partialSum, a) => partialSum + a, 0)
        totalSum += weeklyAverage;
    }
    for (const addressActData of qualifiedGamesForPreviousWeek) {
        let weeklyAverage = addressActData.weeklyHoldings.reduce((partialSum, a) => partialSum + a, 0)
        addresses.push(addressActData.address);
        weights.push(Math.floor((weeklyAverage * 10000) / totalSum));
    }

    return {'addresses': addresses, 'weights': weights};
}

async function getPlayersForPreviousWeek() {
    const polygonSlotRounds = await getGameRounds("SlotGameEnteredPolygon");
    const bscSlotRounds = await getGameRounds("SlotGameEnteredBsc");

    return polygonSlotRounds.concat(bscSlotRounds);
}

async function checkIfHadActInPreviousWeek(walletAddress) {
    const configRaw = await getConfigTemplate();
    const config = configRaw.parameters;
    const url = new URL(
        `${config.covalent_url.defaultValue.value}/${config.treasury_chain_id.defaultValue.value}/address/${walletAddress}/portfolio_v2/?key=${config.covalent_api_key.defaultValue.value}`
    );
    const response = await axios.get(url)
    let weeklyHoldings;
    let weeklyHoldingsDTOs = []
    response.data.data.items.forEach(item => {
        if (item.contract_address.toLowerCase() === config.act_address.defaultValue.value.toLowerCase()) {
            weeklyHoldings = item.holdings.map((holding) => {
                // TODO: change to getPreviousMonday()
                if (removeTime(new Date(holding.timestamp)) >= removeTime(getLastMonday())) {
                    return Math.floor(Web3Utils.fromWei(new BN(holding.low.balance).add(new BN(holding.high.balance)).divRound(new BN('2'))));
                }
            });
            if (weeklyHoldings) {
                weeklyHoldings.length = 7;
                weeklyHoldings = weeklyHoldings.filter(n => n >= 0)
                weeklyHoldingsDTOs.push({"address": walletAddress, "weeklyHoldings": weeklyHoldings});
            }
        }
    })
    return weeklyHoldingsDTOs;
}

function removeTime(date = new Date()) {
    return new Date(date.toDateString());
}

async function getQualifiedGamesForPreviousWeek(playersForPreviousWeek) {
    const uniqueAddresses = getUniqueAddresses(playersForPreviousWeek);

    const uniqueQualified = [];
    for (const uniqueAddress of uniqueAddresses) {
        const qualified = await checkIfHadActInPreviousWeek(uniqueAddress);
        if (qualified && qualified.length !== 0) {
            uniqueQualified.push(qualified.pop());
        }
    }
    return uniqueQualified;
}

async function startMoralis() {
    const remoteConfigTemplate = await getConfigTemplate();
    const serverUrl = remoteConfigTemplate.parameters.moralisServerUrl.defaultValue.value;
    const appId = remoteConfigTemplate.parameters.moralisAppId.defaultValue.value;
    const masterKey = remoteConfigTemplate.parameters.moralisMasterKey.defaultValue.value;
    await Moralis.start({serverUrl, appId, masterKey});
}

async function getGameRounds(moralisGameObject) {
    await startMoralis();

    const query = new Moralis.Query(moralisGameObject);
    query.greaterThan("createdAt", getPreviousMonday());
    query.lessThan("createdAt", getLastMonday());
    return await query.find();
}

async function getGoldenTicketWinner(qualifiedPlayersForPreviousWeek) {
    const randomNo = randomIntFromInterval(0, qualifiedPlayersForPreviousWeek.length - 1)

    return qualifiedPlayersForPreviousWeek[randomNo].address;
}

function randomIntFromInterval(min, max) { // min and max included
    return Math.floor(Math.random() * (max - min + 1) + min)
}

function getLastMonday() {
    const prevMonday = new Date();
    prevMonday.setDate(prevMonday.getDate() - (prevMonday.getDay() + 6) % 7);
    prevMonday.setUTCHours(0, 0, 0, 0)
    return prevMonday;
}

function getPreviousMonday() {
    const lastMonday = getLastMonday();
    const pastDate = lastMonday.getDate() - 7;
    lastMonday.setDate(pastDate)

    return lastMonday;
}

async function getConfigTemplate() {
    const remoteConfig = admin.remoteConfig();
    return await remoteConfig.getTemplate().catch(e => {
        console.error(e);
    });
}