// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {QuilcastVote} from "../src/QuilcastVote.sol";

contract QuilcastVoteTest is Test {
    QuilcastVote v = new QuilcastVote("https://vote.quilcast.com/nft.json", "https://vote.quilcast.com/collection.json", address(this));
    address alice = address(0xA11CE);

    function test_votesOncePerWallet() public {
        vm.startPrank(alice);
        v.vote();
        assertEq(v.balanceOf(alice, 1), 1);
        assertEq(v.totalSupply(), 1);
        v.safeTransferFrom(alice, address(0xB0B), 1, 1, "");
        vm.expectRevert("already voted");
        v.vote();
    }

    function test_onlyOwnerMovesMetadata() public {
        v.setURIs("ipfs://a", "ipfs://b");
        assertEq(v.uri(1), "ipfs://a");
        vm.prank(alice);
        vm.expectRevert();
        v.setURIs("x", "y");
    }
}
