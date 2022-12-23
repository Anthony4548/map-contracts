
module.exports = async (taskArgs,hre) => {
    const accounts = await ethers.getSigners()
    const deployer = accounts[0];

    console.log("deployer address:",deployer.address);

    let proxy = await hre.deployments.get("MAPVaultToken");

    console.log("Vault token address:", proxy.address);

    let vaultToken = await ethers.getContractAt('MAPVaultToken',proxy.address);

    await (await vaultToken.connect(deployer).initialize(
            taskArgs.token,
            taskArgs.name,
            taskArgs.symbol,
            "18")
    ).wait();
    console.log("MAPVaultToken initialize success")


}