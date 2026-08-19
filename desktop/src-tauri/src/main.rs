#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub const PORT_MIN: u16 = 3001;
pub const PORT_MAX: u16 = 3020;

mod state;

fn main() {
    println!("icpc-widget skeleton");
}
