// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IBurnToAccessRWA_Attack {
    function burnForAccess(uint256 tokenId) external;
}

/**
 * @notice Malicious receiver used only for tests. Attempts to reenter burnForAccess on ETH receive.
 */
contract BurnPoolAttacker is IERC1155Receiver {
    IBurnToAccessRWA_Attack public immutable pool;
    uint256 public immutable tokenId;
    bool public attackEnabled = true;
    uint256 public reenterAttempts;

    constructor(address pool_, uint256 tokenId_) {
        pool = IBurnToAccessRWA_Attack(pool_);
        tokenId = tokenId_;
    }

    function setAttackEnabled(bool enabled) external {
        attackEnabled = enabled;
    }

    function attack() external {
        pool.burnForAccess(tokenId);
    }

    receive() external payable {
        if (attackEnabled && reenterAttempts < 1) {
            reenterAttempts += 1;
            // try reentering; should fail due to nonReentrant on burnForAccess
            try pool.burnForAccess(tokenId) {} catch {}
        }
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure override returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}


