// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// "I voted for Quilcast as my client of choice": a free open-edition sticker, one per wallet, no end date.
contract QuilcastVote is ERC1155, Ownable {
    string public constant name = "I voted for Quilcast";
    string public constant symbol = "QCVOTE";
    uint256 public constant STICKER = 1;

    string public contractURI;
    uint256 public totalSupply;
    mapping(address => bool) public voted;

    event ContractURIUpdated();

    constructor(string memory uri_, string memory contractURI_, address owner_) ERC1155(uri_) Ownable(owner_) {
        contractURI = contractURI_;
    }

    /// Mints the sticker to the caller. A wallet votes once, even if it later sends the sticker away.
    function vote() external {
        require(!voted[msg.sender], "already voted");
        voted[msg.sender] = true;
        totalSupply++;
        _mint(msg.sender, STICKER, 1, "");
    }

    /// Lets the metadata move (e.g. to IPFS) without a new contract.
    function setURIs(string calldata uri_, string calldata contractURI_) external onlyOwner {
        _setURI(uri_);
        contractURI = contractURI_;
        emit URI(uri_, STICKER);
        emit ContractURIUpdated();
    }
}
