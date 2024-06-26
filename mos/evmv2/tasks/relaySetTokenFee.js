
module.exports = async (taskArgs,hre) => {
    const accounts = await ethers.getSigners()
    const deployer = accounts[0];

    console.log("deployer address:",deployer.address);

    //let tokenmanager = await hre.deployments.get("TokenRegisterProxy");

    //console.log("Token manager address:", tokenmanager.address);

    //let manager = await ethers.getContractAt('TokenRegisterV2', tokenmanager.address);

    let manager = await ethers.getContractAt('TokenRegisterV2', "0xff44790d336d3C004F2Dac7e401E4EA5680529dD");

    await (await manager.connect(deployer).setTokenFee(
            taskArgs.token,
            taskArgs.chain,
            taskArgs.min,
            taskArgs.max,
            taskArgs.rate)
    ).wait();

    console.log(`Token register manager set token ${taskArgs.token} to chain ${taskArgs.chain} fee success`)


}