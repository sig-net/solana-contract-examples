import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaCoreContracts } from "../target/types/solana_core_contracts";

async function main() {
  // Setup Anchor provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Initialize program
  const program = anchor.workspace
    .SolanaCoreContracts as Program<SolanaCoreContracts>;

  // New MPC root signer address
  const newAddress = "0x1Be31A94361a391bBaFB2a4CCd704F57dc04d4bb";

  // Convert hex address to bytes array
  const addressBytes = Array.from(
    Buffer.from(newAddress.slice(2), "hex")
  ) as number[];

  // Derive config PDA
  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault_config")],
    program.programId
  );

  console.log("📍 Updating config...");
  console.log("  Contract:", program.programId.toString());
  console.log("  Config PDA:", config.toString());
  console.log("  New MPC Root Signer Address:", newAddress);

  try {
    const tx = await program.methods
      .updateConfig(addressBytes as any)
      .accounts({
        config,
      })
      .rpc();

    console.log("  ✅ Transaction signature:", tx);
    console.log("  ✅ Config updated successfully!");

    // Verify the update
    const configAccount = await program.account.vaultConfig.fetch(config);
    const updatedAddress = "0x" + Buffer.from(configAccount.mpcRootSignerAddress).toString("hex");
    console.log("  📊 Verified address:", updatedAddress);
  } catch (error) {
    console.error("❌ Error updating config:", error);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
