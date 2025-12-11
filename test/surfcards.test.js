import { expect } from "chai";
import pkg from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
const { ethers } = pkg;

describe("Surf stack", () => {
  async function deployFixture() {
    const [deployer, user, other] = await ethers.getSigners();

    const VRF = await ethers.getContractFactory("VRFCoordinatorMock");
    const vrf = await VRF.deploy();
    await vrf.waitForDeployment();
    const vrfAddr = await vrf.getAddress();

    const Burn = await ethers.getContractFactory("BurnToAccessRWA");
    const burn = await Burn.deploy(ethers.ZeroAddress);
    await burn.waitForDeployment();
    const burnAddr = await burn.getAddress();

    const Treasury = await ethers.getContractFactory("FutarchyTreasury");
    const treasury = await Treasury.deploy();
    await treasury.waitForDeployment();
    const treasuryAddr = await treasury.getAddress();

    const Surf = await ethers.getContractFactory("SurfCardsNFT");
    const surf = await Surf.deploy(
      vrfAddr,
      1, // sub id
      ethers.ZeroHash,
      "ipfs://base/",
      burnAddr,
      treasuryAddr
    );
    await surf.waitForDeployment();
    const surfAddr = await surf.getAddress();

    // link surf to burn if not set
    await burn.setSurfCards(surfAddr);

    const Staking = await ethers.getContractFactory("ProposalStaking");
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const lpToken = await MockERC20.deploy("LP", "LP");
    await lpToken.waitForDeployment();
    const lpAddr = await lpToken.getAddress();
    const staking = await Staking.deploy(lpAddr);
    await staking.waitForDeployment();
    const stakingAddr = await staking.getAddress();

    const Gov = await ethers.getContractFactory("FutarchyGovernance");
    const gov = await Gov.deploy(stakingAddr, treasuryAddr);
    await gov.waitForDeployment();
    const govAddr = await gov.getAddress();

    await treasury.setGovernance(govAddr);
    await staking.setGovernance(govAddr);

    // set auction start to now
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await surf.setAuctionStart(now + 3600); // keep price at startPrice during tests

    return { deployer, user, other, vrf, burn, treasury, surf, staking, gov, lpToken };
  }

  it("reward distributor splits ETH equally", async () => {
    const [sender, a, b] = await ethers.getSigners();
    const RD = await ethers.getContractFactory("RewardDistributor");
    const rd = await RD.deploy();
    await rd.waitForDeployment();

    const recipients = [a.address, b.address];
    const value = ethers.parseEther("1");

    const beforeA = await ethers.provider.getBalance(a.address);
    const beforeB = await ethers.provider.getBalance(b.address);

    await rd.connect(sender).distribute(recipients, { value });

    const afterA = await ethers.provider.getBalance(a.address);
    const afterB = await ethers.provider.getBalance(b.address);

    expect(afterA - beforeA).to.equal(ethers.parseEther("0.5"));
    expect(afterB - beforeB).to.equal(ethers.parseEther("0.5"));
  });

  it("dutch auction returns a sane price", async () => {
    const { surf } = await loadFixture(deployFixture);
    const auctionAddr = await surf.auction();
    const auction = await ethers.getContractAt("DutchAuction", auctionAddr);
    const price = await auction.getCurrentPrice();
    expect(price).to.be.greaterThan(0);
  });

  it("mints 1of1 at current auction price", async () => {
    const { surf, user } = await loadFixture(deployFixture);
    const auctionAddr = await surf.auction();
    const auction = await ethers.getContractAt("DutchAuction", auctionAddr);
    const price = await auction.getCurrentPrice();
    await expect(surf.connect(user).mintOneOfOne(1, { value: price })).to.emit(surf, "OneOfOneMinted");
  });

  it("routes pack proceeds 50/50 and mints commons via VRF", async () => {
    const { surf, vrf, burn, treasury, user } = await loadFixture(deployFixture);
    const tx = await surf.connect(user).buyPack({ value: ethers.parseEther("0.01") });
    await tx.wait();
    const prLogs = await surf.queryFilter("PackRequested");
    const requestId = prLogs[prLogs.length - 1].args.requestId;
    await vrf.fulfill(requestId);

    const burnBal = await ethers.provider.getBalance(await burn.getAddress());
    const treasBal = await ethers.provider.getBalance(await treasury.getAddress());
    expect(burnBal).to.equal(ethers.parseEther("0.005"));
    expect(treasBal).to.equal(ethers.parseEther("0.005"));

    const openedLogs = await surf.queryFilter("PackOpened");
    const last = openedLogs[openedLogs.length - 1];
    expect(last.args.tokenIds.length).to.equal(7);
  });

  it("burn-for-access pays equal share", async () => {
    const { surf, burn, user } = await loadFixture(deployFixture);
    const auctionAddr = await surf.auction();
    const auction = await ethers.getContractAt("DutchAuction", auctionAddr);
    const price = await auction.getCurrentPrice();
    await surf.connect(user).mintOneOfOne(1, { value: price });
    // pool has half of price
    const beforePool = BigInt(await ethers.provider.getBalance(await burn.getAddress()));
    const tx = await burn.connect(user).burnForAccess(1);
    await tx.wait();
    const afterPool = BigInt(await ethers.provider.getBalance(await burn.getAddress()));
    const payout = BigInt(price) / 2n / 35n; // burn pool receives half, split across remaining 35
    expect(beforePool - afterPool).to.equal(payout);
  });

  it("burn-for-access is not reentrancy exploitable", async () => {
    const { surf, burn, user } = await loadFixture(deployFixture);
    const auctionAddr = await surf.auction();
    const auction = await ethers.getContractAt("DutchAuction", auctionAddr);
    const price = await auction.getCurrentPrice();

    // Mint 1of1 to attacker contract
    const Attacker = await ethers.getContractFactory("BurnPoolAttacker");
    const attacker = await Attacker.deploy(await burn.getAddress(), 1);
    await attacker.waitForDeployment();
    const attackerAddr = await attacker.getAddress();

    await surf.connect(user).mintOneOfOne(1, { value: price });
    // transfer token to attacker
    await surf.connect(user).safeTransferFrom(user.address, attackerAddr, 1, 1, "0x");

    const beforePool = BigInt(await ethers.provider.getBalance(await burn.getAddress()));
    await attacker.connect(user).attack();
    const afterPool = BigInt(await ethers.provider.getBalance(await burn.getAddress()));

    // Only one payout should occur; reentry attempt is blocked by nonReentrant and caught in receive()
    const payout = BigInt(price) / 2n / 35n;
    expect(beforePool - afterPool).to.equal(payout);
  });

  it("burn pool rejects deposits from non-SurfCards callers", async () => {
    const { burn, user } = await loadFixture(deployFixture);
    await expect(user.sendTransaction({ to: await burn.getAddress(), value: ethers.parseEther("0.1") })).to.not.be
      .reverted; // receive() allows ETH (optional funding), but deposit() must be restricted
    await expect(burn.connect(user).deposit({ value: 1 })).to.be.reverted;
  });

  it("proposal staking enforces 5% threshold on total staked", async () => {
    const { staking, lpToken, user, other } = await loadFixture(deployFixture);
    const stakingAddr = await staking.getAddress();
    await lpToken.mint(user.address, ethers.parseEther("100"));
    await lpToken.mint(other.address, ethers.parseEther("100"));
    await lpToken.connect(user).approve(stakingAddr, ethers.parseEther("100"));
    await lpToken.connect(other).approve(stakingAddr, ethers.parseEther("100"));

    const desc = "test proposal";
    const execData = "0x1234";
    const tx = await staking.connect(user).createProposal(desc, execData);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const id = ethers.keccak256(
      ethers.solidityPacked(["address", "uint256", "bytes"], [user.address, block.timestamp, execData])
    );

    // total stake 10, yes stake 6 -> passes (5% threshold on total staked)
    await staking.connect(user).stakeFor(id, ethers.parseEther("6"));
    await staking.connect(other).stakeAgainst(id, ethers.parseEther("4"));
    await time.increase(7 * 24 * 3600 + 1);
    await staking.finalizeProposal(id);
    const p = await staking.proposals(id);
    expect(p.state).to.equal(1); // Passed
  });

  it("governance executes via treasury to harpoonFactory target", async () => {
    const { staking, treasury, gov, lpToken, user } = await loadFixture(deployFixture);
    const stakingAddr = await staking.getAddress();
    await lpToken.mint(user.address, ethers.parseEther("10"));
    await lpToken.connect(user).approve(stakingAddr, ethers.parseEther("10"));

    // deploy mock target
    const MockTarget = await ethers.getContractFactory("MockTarget");
    const target = await MockTarget.deploy();

    const tx = await staking.connect(user).createProposal("call target", "0x"); // empty calldata hits fallback
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const id = ethers.keccak256(
      ethers.solidityPacked(["address", "uint256", "bytes"], [user.address, block.timestamp, "0x"])
    );

    await staking.connect(user).stakeFor(id, ethers.parseEther("10"));
    await time.increase(7 * 24 * 3600 + 1);
    await staking.finalizeProposal(id);

    await gov.setHarpoonFactory(await target.getAddress());
    await treasury.setGovernance(await gov.getAddress());

    await gov.finalizeAndExecute(id, 0);
    expect(await target.called()).to.equal(1);
  });
});

