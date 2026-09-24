// ⚠ BINAIRE VENDEUR — jamais distribué aux clients.
//   pff-keygen init
//   pff-keygen sign --hwid HWID-XXXX-XXXX-XXXX-XXXX --plan ANNUAL --serial PF-2026-000001 --days 365
//   pff-keygen sign --hwid HWID-XXXX-XXXX-XXXX-XXXX --plan LIFETIME --serial PF-2026-000002
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    println!("{}", profast_facture_lib::license::keygen::main_cli(&args));
}
