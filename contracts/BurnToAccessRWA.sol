// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface ISurfCardsBurnable {
    function burnOneOfOne(address owner, uint256 tokenId) external;
    function isOneOfOne(uint256 tokenId) external view returns (bool);
}

/**
 * @title BurnToAccessRWA
 * @notice Holds 50% of mint proceeds; 1of1 holders can burn to claim pro-rata share.
 */
contract BurnToAccessRWA is ReentrancyGuard, Ownable {
    ISurfCardsBurnable public surfCards;
    uint256 public remainingOneOfOnes = 35; // total 1of1 supply

    event Deposited(address indexed from, uint256 amount);
    event BurnedForAccess(address indexed owner, uint256 tokenId, uint256 payout);

    error NotSurfCards();
    error NotOwnerOrInvalid();
    error NoRemaining();

    constructor(address surfCardsAddress) Ownable(msg.sender) {
        if (surfCardsAddress != address(0)) {
            surfCards = ISurfCardsBurnable(surfCardsAddress);
        }
    }

    modifier onlySurfCards() {
        if (address(surfCards) == address(0) || msg.sender != address(surfCards)) revert NotSurfCards();
        _;
    }

    /**
     * @notice One-time set of SurfCardsNFT address if not provided at deploy.
     */
    function setSurfCards(address surfCardsAddress) external onlyOwner {
        require(address(surfCards) == address(0), "surf set");
        require(surfCardsAddress != address(0), "invalid surf");
        surfCards = ISurfCardsBurnable(surfCardsAddress);
    }

    /**
     * @notice Accept proceeds from SurfCardsNFT.
     */
    function deposit() external payable onlySurfCards {
        emit Deposited(msg.sender, msg.value);
    }

    /**
     * @notice Burn a 1of1 to claim proportional share of pool.
     */
    function burnForAccess(uint256 tokenId) external nonReentrant {
        if (!surfCards.isOneOfOne(tokenId)) revert NotOwnerOrInvalid();
        if (remainingOneOfOnes == 0) revert NoRemaining();

        uint256 share = address(this).balance / remainingOneOfOnes;
        remainingOneOfOnes -= 1;

        surfCards.burnOneOfOne(msg.sender, tokenId);

        (bool ok, ) = msg.sender.call{value: share}("");
        require(ok, "transfer failed");

        emit BurnedForAccess(msg.sender, tokenId, share);
    }

    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }
}

