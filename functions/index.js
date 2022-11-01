const functions = require("firebase-functions");
const admin = require('firebase-admin');
const ethers = require('ethers');
const cors = require('cors');
// const cors = require('cors')({
//     origin: '*',
// });


admin.initializeApp(functions.config().firebase);

exports.helloWorld = functions.https.onRequest((req, res) => {
    res.send("Hello from Firebase!");
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

async function getConfigTemplate() {
    const remoteConfig = admin.remoteConfig();
    return await remoteConfig.getTemplate().catch(e => {
        console.error(e);
    });
}